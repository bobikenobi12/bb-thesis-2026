// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// /api/cli/projects/:id/byo-iac — read, attach and detach the customer's BYO Terraform/OpenTofu source for an
// environment (or null when none). Gated on project `view`; org-scoped via an explicit
// projects.org_id filter (RLS bypassed here). Mirrors getIacSource (web) but omits the full scan
// report — status only.

import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { attachIacSource, detachIacSource } from "@/app/server/actions/byo-iac";
import { runWithActor } from "@/lib/authz/actor-context";
import { authorizeCli } from "@/lib/authz/guard";
import { byoWriteError, resolveByoScope } from "@/lib/cli/byo-write";
import {
	resolveCliEnvironment,
	resolveCliProject,
	resolveDefaultEnvironmentId,
} from "@/lib/cli/resolve-project";
import { cliJson } from "@/lib/cli/respond";
import { getServiceDb } from "@/lib/db";
import { projectIacSources, projects } from "@/lib/db/schema";
import {
	isNotReservedTfvarKey,
	RESERVED_TFVAR_MESSAGE,
} from "@/lib/validations/byo-iac";
import {
	cliByoChartAttachResponse,
	cliIacSourceResponse,
	cliOkResponse,
} from "@/lib/validations/cli-contract";

export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const auth = await authorizeCli(req, "view", { type: "project" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;
	const { id } = await params;
	const envParam = new URL(req.url).searchParams.get("env");

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
		if (!environmentId) return cliJson(cliIacSourceResponse, { source: null });

		const db = getServiceDb();
		const [row] = await db
			.select({
				id: projectIacSources.id,
				name: projectIacSources.name,
				repo_url: projectIacSources.repo_url,
				ref: projectIacSources.ref,
				path: projectIacSources.path,
				commit_sha: projectIacSources.commit_sha,
				deployed_commit_sha: projectIacSources.deployed_commit_sha,
				enabled: projectIacSources.enabled,
				scan_status: projectIacSources.scan_status,
				scanned_at: projectIacSources.scanned_at,
				status: projectIacSources.status,
				status_message: projectIacSources.status_message,
			})
			.from(projectIacSources)
			.innerJoin(projects, eq(projectIacSources.project_id, projects.id))
			.where(
				and(
					eq(projectIacSources.project_id, project.id),
					eq(projectIacSources.environment_id, environmentId),
					eq(projects.org_id, actor.orgId),
				),
			)
			.limit(1);

		if (!row) return cliJson(cliIacSourceResponse, { source: null });

		return cliJson(cliIacSourceResponse, {
			source: {
				id: row.id,
				environment: environmentName,
				name: row.name,
				repo_url: row.repo_url,
				ref: row.ref,
				path: row.path,
				commit_sha: row.commit_sha,
				deployed_commit_sha: row.deployed_commit_sha,
				enabled: row.enabled,
				scan_status: row.scan_status,
				scanned_at: row.scanned_at?.toISOString() ?? null,
				status: row.status,
				status_message: row.status_message,
			},
		});
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}

/**
 * Body of POST .../byo-iac — attach (or replace) the environment's BYO IaC source.
 *
 * snake_case matches `iacSourceAttachSchema`'s own field names, so this body IS that shape plus
 * nothing. `attachIacSource` re-parses it with that schema, which is what normalises the path
 * ("/foo/" → "foo") and enforces the scalar-only tfvars rule — a nested object or an array in
 * `var_values` is refused there rather than being written and failing at apply.
 */
const attachIacBody = z.object({
	repo_url: z.string().trim().min(1),
	ref: z.string().trim().min(1).nullish(),
	path: z.string().trim().optional(),
	git_credential_id: z.string().uuid().nullish(),
	// The reserved platform namespace, checked HERE and not only in the action. attachIacSource
	// validates with the throwing `.parse()`, and byoWriteError classifies an escaped ZodError by
	// regex over its message — which for this rule fell through to a 500 carrying a raw Zod dump.
	// A rule the CLI can trip needs a 400 that names the field, not a server fault.
	var_values: z
		.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
		.refine(
			(v) => Object.keys(v).every(isNotReservedTfvarKey),
			RESERVED_TFVAR_MESSAGE,
		)
		.optional(),
});

/** Attaches the environment's BYO IaC source. */
export async function POST(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const auth = await authorizeCli(req, "edit", { type: "project" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;
	const { id } = await params;

	const parsed = attachIacBody.safeParse(await req.json().catch(() => null));
	if (!parsed.success) {
		// The ACTUAL first issue, not a fixed sentence. This used to answer "repo_url is required"
		// whatever had failed, which for any rule but that one names the wrong field.
		const first = parsed.error.issues[0];
		const where = first === undefined || first.path.length === 0 ? "" : `${first.path.join(".")}: `;
		return NextResponse.json(
			{ error: `Invalid request body: ${where}${first?.message ?? "repo_url is required"}` },
			{ status: 400 },
		);
	}
	const b = parsed.data;

	try {
		const scope = await resolveByoScope(actor.orgId, id, req);
		if ("error" in scope) return scope.error;

		const result = await runWithActor(actor, () =>
			attachIacSource({
				projectId: scope.projectId,
				environmentId: scope.environmentId,
				repoUrl: b.repo_url,
				ref: b.ref ?? null,
				path: b.path,
				gitCredentialId: b.git_credential_id ?? null,
				varValues: b.var_values,
			}),
		);
		return cliJson(
			cliByoChartAttachResponse,
			{ ok: true, id: result.id },
			{ status: 201 },
		);
	} catch (err: unknown) {
		return byoWriteError(err);
	}
}

/** Detaches the environment's BYO IaC source. The environment is the whole address — an environment
 *  holds at most one source — so there is no body. */
export async function DELETE(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const auth = await authorizeCli(req, "edit", { type: "project" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;
	const { id } = await params;

	try {
		const scope = await resolveByoScope(actor.orgId, id, req);
		if ("error" in scope) return scope.error;

		await runWithActor(actor, () =>
			detachIacSource({
				projectId: scope.projectId,
				environmentId: scope.environmentId,
			}),
		);
		return cliJson(cliOkResponse, { ok: true });
	} catch (err: unknown) {
		return byoWriteError(err);
	}
}
