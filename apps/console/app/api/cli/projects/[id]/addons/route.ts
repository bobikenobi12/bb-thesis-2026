// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// /api/cli/projects/:id/addons — read, enable and disable the catalog add-ons in an environment (defaults to
// the project's default environment; pass ?env= for another). Gated on project `view`; org-scoped
// via an explicit projects.org_id filter (RLS is bypassed here). This is the CLI's "what's
// installed here" view — the console marketplace catalog browsing stays web-only.

import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { disableAddon, enableAddon } from "@/app/server/actions/addons";
import { runWithActor } from "@/lib/authz/actor-context";
import { authorizeCli } from "@/lib/authz/guard";
import {
	type CursorScope,
	MAX_PAGE_SIZE,
	cursorKey,
	paginate,
	parsePageOpts,
} from "@/lib/cli/paging";
import {
	resolveCliEnvironment,
	resolveCliProject,
	resolveCliWriteEnvironment,
	resolveDefaultEnvironmentId,
} from "@/lib/cli/resolve-project";
import { cliEnvironmentError, cliJson } from "@/lib/cli/respond";
import { getServiceDb } from "@/lib/db";
import { projectAddons, projects } from "@/lib/db/schema";
import { addonMode } from "@/lib/db/schema/enums";
import { cliAddonsResponse, cliOkResponse } from "@/lib/validations/cli-contract";

const ADDONS_LIST = "project-addons";

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
	const cursorScope: CursorScope = { orgId: actor.orgId, list: ADDONS_LIST };
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
			return cliJson(cliAddonsResponse, { environment: environmentName, addons: [] });
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
				eq(projectAddons.source, "catalog"),
			],
			cursor: cursorScope,
			opts,
			rows: (query) =>
				db
					.select({
						id: projectAddons.id,
						addon_id: projectAddons.addon_id,
						enabled: projectAddons.enabled,
						mode: projectAddons.mode,
						version: projectAddons.version,
						namespace: projectAddons.namespace,
						status: projectAddons.status,
						health: projectAddons.health,
						sync_status: projectAddons.sync_status,
						last_synced_at: projectAddons.last_synced_at,
						cursor_key: cursorKey(projectAddons.created_at),
					})
					.from(projectAddons)
					.innerJoin(projects, eq(projectAddons.project_id, projects.id))
					.where(and(query.where, eq(projects.org_id, actor.orgId)))
					.orderBy(...query.orderBy)
					.limit(query.limit),
			positionOf: (row) => ({ createdAt: row.cursor_key, id: row.id }),
		});

		return cliJson(cliAddonsResponse, {
			environment: environmentName,
			addons: items.map(({ id: _id, cursor_key: _cursor, ...r }) => ({
				addon_id: r.addon_id,
				enabled: r.enabled,
				mode: r.mode,
				version: r.version,
				namespace: r.namespace,
				status: r.status,
				health: r.health,
				sync: r.sync_status,
				last_synced_at: r.last_synced_at?.toISOString() ?? null,
			})),
			page,
		});
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}

/** Body of POST .../addons — enable or reconfigure one catalog add-on.
 *
 * `values` is intentionally an open record at the EDGE and narrowed immediately after: `enableAddon`
 * runs the add-on's own `def.configSchema.safeParse` on it, so each add-on's knobs are validated by
 * the definition that owns them rather than by a second schema here that would drift from the
 * catalog. `values_yaml` is the Advanced raw-Helm escape hatch, parsed and rejected as YAML by the
 * same action. */
const enableAddonBody = z.object({
	addon_id: z.string().min(1),
	mode: z.enum(addonMode.enumValues).optional(),
	values: z.record(z.string(), z.unknown()).optional(),
	values_yaml: z.string().nullish(),
});

/**
 * Enables (or reconfigures) a catalog add-on in an environment.
 *
 * Everything that matters is `enableAddon`'s, reached through `runWithActor` rather than
 * reimplemented: the per-add-on `configSchema` validation, the YAML-mapping check, and
 * `mergeAddonSecrets` — which is why a reconfigure cannot blank a secret the caller did not resend.
 * Duplicating any of that here would mean two definitions of what a valid add-on config is, and only
 * one of them would be the one the console enforces.
 */
export async function POST(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const auth = await authorizeCli(req, "edit", { type: "project" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;
	const { id } = await params;

	const parsed = enableAddonBody.safeParse(await req.json().catch(() => null));
	if (!parsed.success) {
		return NextResponse.json(
			{ error: "Invalid request body: addon_id is required" },
			{ status: 400 },
		);
	}

	try {
		const project = await resolveCliProject(actor.orgId, id);
		if (!project) {
			return NextResponse.json({ error: "Project not found" }, { status: 404 });
		}
		const target = await resolveCliWriteEnvironment(
			project.id,
			new URL(req.url).searchParams.get("env"),
		);
		if (!target.ok) return cliEnvironmentError(target);

		await runWithActor(actor, () =>
			enableAddon({
				projectId: project.id,
				environmentId: target.id,
				addonId: parsed.data.addon_id,
				mode: parsed.data.mode,
				values: parsed.data.values,
				valuesYaml: parsed.data.values_yaml ?? null,
			}),
		);
		return cliJson(cliOkResponse, { ok: true }, { status: 201 });
	} catch (err: unknown) {
		return addonWriteError(err);
	}
}

/** Body of DELETE .../addons — disable one add-on. */
const disableAddonBody = z.object({ addon_id: z.string().min(1) });

/** Disables a catalog add-on in an environment. */
export async function DELETE(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const auth = await authorizeCli(req, "edit", { type: "project" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;
	const { id } = await params;

	const parsed = disableAddonBody.safeParse(await req.json().catch(() => null));
	if (!parsed.success) {
		return NextResponse.json(
			{ error: "Invalid request body: addon_id is required" },
			{ status: 400 },
		);
	}

	try {
		const project = await resolveCliProject(actor.orgId, id);
		if (!project) {
			return NextResponse.json({ error: "Project not found" }, { status: 404 });
		}
		const target = await resolveCliWriteEnvironment(
			project.id,
			new URL(req.url).searchParams.get("env"),
		);
		if (!target.ok) return cliEnvironmentError(target);

		await runWithActor(actor, () =>
			disableAddon({
				projectId: project.id,
				environmentId: target.id,
				addonId: parsed.data.addon_id,
			}),
		);
		return cliJson(cliOkResponse, { ok: true });
	} catch (err: unknown) {
		return addonWriteError(err);
	}
}

/**
 * Maps an add-on write failure to a status the caller can act on.
 *
 * `enableAddon` throws for three distinct reasons and they deserve different codes: an unknown
 * add-on id or an invalid config is the caller's (400), an authorization refusal is 403, and anything
 * else is ours (500). Collapsing them into 500 would report a typo'd add-on id as a server fault.
 */
function addonWriteError(err: unknown): NextResponse {
	const message = err instanceof Error ? err.message : "Internal Server Error";
	if (/^Unknown add-on:|^Invalid add-on configuration:|values_yaml/i.test(message)) {
		return NextResponse.json({ error: message }, { status: 400 });
	}
	if (/forbidden|not authorized|permission/i.test(message)) {
		return NextResponse.json({ error: message }, { status: 403 });
	}
	return NextResponse.json({ error: message }, { status: 500 });
}
