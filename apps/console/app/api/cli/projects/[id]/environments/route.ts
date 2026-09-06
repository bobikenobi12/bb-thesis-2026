// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { authorizeCli } from "@/lib/authz/guard";
import {
	type CursorScope,
	MAX_PAGE_SIZE,
	cursorKey,
	paginate,
	parsePageOpts,
} from "@/lib/cli/paging";
import { resolveCliProject } from "@/lib/cli/resolve-project";
import { getServiceDb } from "@/lib/db";
import { projectEnvironments, projectFabrics } from "@/lib/db/schema";
import {
	environmentLifecycle,
	environmentStage,
	placementMode,
} from "@/lib/db/schema/enums";
import { NextResponse } from "next/server";
import { cliJson } from "@/lib/cli/respond";
import {
	environmentNameSchema,
	namespaceSchema,
} from "@/lib/validations/names";
import {
	cliEnvironmentResponse,
	cliEnvironmentsResponse,
} from "@/lib/validations/cli-contract";

const ENVIRONMENTS_LIST = "project-environments";

/** Body of POST /api/cli/projects/:id/environments — add an environment.
 *
 * `placement_mode` and its companions are the fix for a silent cost bomb. This route inserted with
 * `fabric_id` unset, and `project_environments.placement_mode` defaults to `dedicated` — so
 * `project env add staging` did not fail, it quietly became a WHOLE NEW CLUSTER with its own tofu
 * state key. The isolation ladder the product leads with (namespace → vcluster → dedicated) was
 * unreachable from the CLI, and the cheap rungs are the interesting ones. */
const addEnvironmentBody = z.object({
	/** Validated AND normalized by the shared rule (lib/validations/names.ts), which is the same
	 *  one `project create --env` and the console's own `addEnvironment` action now use. Parsing
	 *  yields the stored slug, so this route cannot forget the normalization step — and it now
	 *  refuses a name a console route would permanently shadow (`project env add settings` used to
	 *  create an environment whose URL was unreachable forever). */
	name: environmentNameSchema,
	stage: z.enum(environmentStage.enumValues).default("development"),
	region: z.string().min(1).optional(),
	/** Defaults to `namespace`: an environment ADDED to an existing project is the cheap-rung case,
	 *  and the expensive one should be the word you typed rather than the one you got. */
	placement_mode: z.enum(placementMode.enumValues).default("namespace"),
	/** The Fabric to place onto, by name. Ignored for `dedicated` (which owns a new Fabric).
	 *  Defaults to the project's default Fabric — "the second tier is free" only works if a shared
	 *  placement lands on the Fabric that already exists. */
	fabric: z.string().min(1).optional(),
	/** ArgoCD destination namespace for a shared placement. NULL → derived from the env name.
	 *  Kubernetes' own grammar, exactly. The pattern here required a leading letter and constrained
	 *  nothing at the end, so it ACCEPTED `dev-` — which Kubernetes refuses, making the failure
	 *  arrive at apply time naming a namespace rather than a name — and refused `1dev`, which
	 *  Kubernetes accepts. */
	namespace: namespaceSchema.optional(),
	lifecycle: z.enum(environmentLifecycle.enumValues).optional(),
});

/** A Fabric in this project, by name. `(project_id, name)` is unique, so at most one. */
async function findFabricByName(
	db: ReturnType<typeof getServiceDb>,
	projectId: string,
	name: string,
): Promise<string | null> {
	const [row] = await db
		.select({ id: projectFabrics.id })
		.from(projectFabrics)
		.where(
			and(eq(projectFabrics.project_id, projectId), eq(projectFabrics.name, name)),
		)
		.limit(1);
	return row?.id ?? null;
}

/**
 * The Fabric a shared placement lands on when the caller names none.
 *
 * `project_fabrics` has NO `is_default` column — the default Fabric is the one the project's DEFAULT
 * ENVIRONMENT is placed on, which is also the Fabric that owns a cluster. Falls back to the project's
 * earliest Fabric if the default env somehow carries no `fabric_id`.
 */
async function findDefaultFabric(
	db: ReturnType<typeof getServiceDb>,
	projectId: string,
): Promise<string | null> {
	const [defaultEnv] = await db
		.select({ fabric_id: projectEnvironments.fabric_id })
		.from(projectEnvironments)
		.where(eq(projectEnvironments.project_id, projectId))
		.orderBy(desc(projectEnvironments.is_default), projectEnvironments.created_at)
		.limit(1);
	if (defaultEnv?.fabric_id) return defaultEnv.fabric_id;

	const [earliest] = await db
		.select({ id: projectFabrics.id })
		.from(projectFabrics)
		.where(eq(projectFabrics.project_id, projectId))
		.orderBy(projectFabrics.created_at)
		.limit(1);
	return earliest?.id ?? null;
}

/** Maps an environment row to its CLI wire shape.
 *
 * `fabricName` is passed in rather than read off the row, because the row carries only
 * `fabric_id` and a uuid does not communicate the thing worth seeing: that five environments
 * share ONE Fabric. Callers resolve the name (GET joins, POST looks up the one it just placed). */
function toEnvironmentWire(
	row: typeof projectEnvironments.$inferSelect,
	fabricName: string | null,
) {
	return {
		id: row.id,
		name: row.name,
		stage: row.stage,
		status: row.status,
		is_default: row.is_default,
		region: row.region,
		placement_mode: row.placement_mode,
		namespace: row.namespace,
		fabric: fabricName,
	};
}

/** Lists a project's environments (default first, then by creation). */
export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const auth = await authorizeCli(req, "view", { type: "project" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;
	const { id } = await params;
	const { searchParams } = new URL(req.url);
	const cursorScope: CursorScope = { orgId: actor.orgId, list: ENVIRONMENTS_LIST };
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

		// LEFT join: a `dedicated` environment whose Fabric has not been created yet, and any
		// environment placed on none, must still appear. An inner join would silently drop rows
		// from a list whose job is to account for every tier.
		const db = getServiceDb();
		const { items, page } = await paginate({
			db,
			table: projectEnvironments,
			createdAt: projectEnvironments.created_at,
			id: projectEnvironments.id,
			scope: [eq(projectEnvironments.project_id, project.id)],
			cursor: cursorScope,
			opts,
			rows: (query) =>
				db
					.select({
						environment: projectEnvironments,
						fabricName: projectFabrics.name,
						cursor_key: cursorKey(projectEnvironments.created_at),
					})
					.from(projectEnvironments)
					.leftJoin(projectFabrics, eq(projectEnvironments.fabric_id, projectFabrics.id))
					.where(query.where)
					.orderBy(desc(projectEnvironments.is_default), ...query.orderBy)
					.limit(query.limit),
			positionOf: (row) => ({ createdAt: row.cursor_key, id: row.environment.id }),
		});

		return cliJson(cliEnvironmentsResponse, {
			environments: items.map(({ cursor_key: _cursor, ...r }) =>
				toEnvironmentWire(r.environment, r.fabricName),
			),
			page,
		});
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}

/** Adds a non-default environment to a project (name normalized by the shared env-name rule;
 *  region inherits the project). */
export async function POST(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const auth = await authorizeCli(req, "edit", { type: "project" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;
	const { id } = await params;

	const parsed = addEnvironmentBody.safeParse(await req.json().catch(() => null));
	if (!parsed.success) {
		// The name rules carry their own messages ("settings" is reserved, "must contain at least
		// one letter or number"); a bare "Invalid request body" would tell the operator nothing
		// about a name the server will never accept.
		const issue = parsed.error.issues[0];
		return NextResponse.json(
			{ error: issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "Invalid request body" },
			{ status: 400 },
		);
	}
	// Already the stored slug — environmentNameSchema normalizes on parse.
	const name = parsed.data.name;

	try {
		const db = getServiceDb();
		const project = await resolveCliProject(actor.orgId, id);
		if (!project) {
			return NextResponse.json({ error: "Project not found" }, { status: 404 });
		}

		// Resolve the Fabric to place onto. `dedicated` owns a new Fabric, so it takes none here (the
		// provisioner creates it); a shared placement MUST land on an existing one, defaulting to the
		// project's default Fabric — which is what makes a second tier free rather than a second cluster.
		let fabricId: string | null = null;
		const mode = parsed.data.placement_mode;
		if (mode !== "dedicated") {
			const fabricName = parsed.data.fabric;
			fabricId = fabricName
				? await findFabricByName(db, project.id, fabricName)
				: await findDefaultFabric(db, project.id);
			if (!fabricId) {
				return NextResponse.json(
					{
						error: fabricName
							? `Fabric "${fabricName}" not found in this project`
							: "Project has no Fabric to place this environment onto",
					},
					{ status: fabricName ? 404 : 400 },
				);
			}
		}

		const [row] = await db
			.insert(projectEnvironments)
			.values({
				project_id: project.id,
				user_id: actor.userId,
				org_id: actor.orgId,
				name,
				stage: parsed.data.stage,
				status: "DRAFT",
				// TRUE WHEN THE PROJECT HAS NONE — see the same expression in
				// app/server/actions/projects.ts. A flat `false` made a project that had reached
				// zero environments unrepairable: the constraint trigger refuses the very insert
				// that would fix it, and the CLI surfaced that as a raw 500.
				is_default: sql<boolean>`NOT EXISTS (
					SELECT 1 FROM public.project_environments e
					 WHERE e.project_id = ${project.id}::uuid AND e.is_default
				)`,
				region: parsed.data.region ?? null,
				fabric_id: fabricId,
				placement_mode: mode,
				namespace: parsed.data.namespace ?? null,
				...(parsed.data.lifecycle ? { lifecycle: parsed.data.lifecycle } : {}),
			})
			.returning();

		// Resolve the Fabric's NAME for the response. It is not necessarily the one the caller
		// typed: a shared placement with no `--fabric` defaults to the project's default Fabric,
		// and echoing back which one it actually landed on is the confirmation that matters.
		let fabricName: string | null = null;
		if (fabricId) {
			const [f] = await db
				.select({ name: projectFabrics.name })
				.from(projectFabrics)
				.where(eq(projectFabrics.id, fabricId))
				.limit(1);
			fabricName = f?.name ?? null;
		}

		return cliJson(
			cliEnvironmentResponse,
			{ environment: toEnvironmentWire(row, fabricName) },
			{ status: 201 },
		);
	} catch (err: unknown) {
		// Duplicate env name for this project (project_id, name unique) → clear 400.
		const message = err instanceof Error ? err.message : "Internal Server Error";
		const status =
			typeof err === "object" && err !== null && "code" in err && err.code === "23505"
				? 400
				: 500;
		return NextResponse.json(
			{ error: status === 400 ? `Environment "${name}" already exists` : message },
			{ status },
		);
	}
}
