// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { eq } from "drizzle-orm";
import type { Tx } from "@/lib/db";
import { mirrorHierarchyEdge } from "@/lib/authz/tuple-sync";
import {
	type EnvironmentLifecycle,
	type EnvironmentStage,
	type PlacementMode,
	type Project,
	projectEnvironments,
	projectFabrics,
	projects,
	resourceHierarchy,
} from "@/lib/db/schema";
import { pickFreeSlug, RESERVED_PROJECT_CHILD_SLUGS } from "@/lib/routing";
import { slugify } from "@/lib/utils/slugify";
import {
	environmentNameProblem,
	namespaceProblem,
	normalizeEnvironmentName,
} from "@/lib/validations/names";

/**
 * Why an environment spec cannot be fanned out, or `null` when it can.
 *
 * Re-validated at all because `createProject` does not re-parse the client input, so a crafted
 * request must not smuggle path separators into a tofu state key or a Fabric name.
 *
 * It asks the SHARED rules (lib/validations/names.ts) rather than keeping its own copy. The copy
 * it used to keep was a pair of bounded charset patterns, one per field, and both required a
 * leading LETTER — the rule #3665 removes, because Kubernetes accepts `1dev`. `POST
 * /api/cli/projects` parses the matrix with `environmentMatrixSchema` and hands it straight to the
 * fan-out, so the two disagreeing meant `alethia project create --env 1dev:namespace` passed
 * validation and then threw out of the fan-out — which the route's catch renders as a 500, not the
 * 400 a rejected name deserves.
 *
 * Exported so that agreement is a TEST rather than a claim: tests/lib/queries-projects-specs.test.ts
 * drives this and `environmentMatrixSchema` over one corpus and asserts they answer alike.
 */
export function environmentSpecProblem(spec: {
	name: string;
	namespace?: string | null;
}): string | null {
	const nameProblem = environmentNameProblem(spec.name);
	if (nameProblem) return `Invalid environment name "${spec.name}": ${nameProblem}`;
	// The name arrives already normalized when it came through environmentMatrixSchema. Checked
	// again because the fan-out is also reachable from callers that never parsed it, and a name
	// that still needs normalizing would be stored in a form no URL resolves.
	const canonical = normalizeEnvironmentName(spec.name);
	if (canonical !== spec.name) {
		return (
			`Invalid environment name "${spec.name}": it must already be normalized ` +
			`("${canonical}") before it reaches the fan-out.`
		);
	}
	if (spec.namespace != null) {
		const nsProblem = namespaceProblem(spec.namespace);
		if (nsProblem) return `Invalid namespace "${spec.namespace}": ${nsProblem}`;
	}
	return null;
}

/** One environment the front door seeds, with its placement onto a Fabric. The placement selector
 * (#844) emits these; the fan-out below turns them into `project_fabrics` + `project_environments`
 * rows — see {@link planFabricPlacement} for which Fabric each one lands on. */
export interface EnvironmentSpec {
	/** Slug-safe env name — also the Fabric name for a `dedicated` env and the tofu state segment. */
	name: string;
	stage: EnvironmentStage;
	placement_mode: PlacementMode;
	/** `persistent` (default) or `ephemeral` (e.g. preview). Data-only seam until the reaper reads it. */
	lifecycle?: EnvironmentLifecycle;
	/** ArgoCD destination namespace for a shared placement; ignored for `dedicated`. */
	namespace?: string | null;
	/** Exactly one spec must be the default — the representative env for single-value surfaces. */
	is_default?: boolean;
}

/**
 * Decide which Fabric each environment in a create-matrix is placed onto.
 *
 * Only a `dedicated` environment provisions a cluster, so a `namespace`/`vcluster` environment must
 * be hosted on some dedicated env's Fabric. `packages/core/provisioner/deploy_namespace.go` enforces
 * the same rule at deploy time and fails closed: "the Fabric's cluster must be provisioned (a
 * 'dedicated' env owning the Fabric) before a namespace env can be placed onto it".
 *
 * This used to mint a separate Fabric literally named `shared` to carry every shared placement — a
 * Fabric NO environment owned, which nothing therefore ever provisioned, leaving every tier on it
 * undeployable from birth. Both sibling paths already had it right (the legacy shape puts Prod and
 * its `preview` namespace env on ONE Fabric; the `project env add` route resolves onto the DEFAULT
 * environment's Fabric), so this is the third path being brought into line rather than a new policy.
 *
 * Pure and exported so the decision is testable without Postgres — the bug lived for as long as it
 * did because the only coverage of the fan-out needed a real database.
 *
 * @throws if a shared placement is present with no `dedicated` env to host it.
 */
export function planFabricPlacement(specs: EnvironmentSpec[]): {
	/** Fabric names to create — one per `dedicated` env, in spec order. */
	fabricNames: string[];
	/** The Fabric name a given spec is placed onto. */
	hostFor: (spec: EnvironmentSpec) => string;
} {
	const dedicated = specs.filter((s) => s.placement_mode === "dedicated");
	const hasShared = specs.some((s) => s.placement_mode !== "dedicated");
	if (hasShared && dedicated.length === 0) {
		throw new Error(
			"At least one environment must be `dedicated`: it owns the Fabric and is what brings the cluster into being. `namespace` and `vcluster` environments are placed onto a cluster that already exists.",
		);
	}
	// Host the cheap tiers on the default env's Fabric when the default is dedicated, so they ride
	// the project's primary cluster; otherwise the first dedicated env in spec order.
	const host = dedicated.find((s) => s.is_default) ?? dedicated[0];
	return {
		fabricNames: dedicated.map((s) => s.name),
		hostFor: (spec) => {
			const name = spec.placement_mode === "dedicated" ? spec.name : host?.name;
			if (!name) throw new Error(`No Fabric for environment "${spec.name}".`);
			return name;
		},
	};
}

/** Scalar inputs the create front door needs — the `project` sub-object of `CreateProjectInput`
 * plus the resolved tenancy (owner + active org). Deliberately narrow: the shared core owns the
 * Fabric + placement invariant, not the form's component graph. */
export interface CreateProjectCoreInput {
	project_name: string;
	region: string;
	cloud_identity_id?: string | null;
	iac_version: string;
	/** Seeds the default Fabric's name AND the default (Production) environment's name + stage. */
	environment_stage: EnvironmentStage;
	/** The default (Production) environment's placement onto its first Fabric. Optional so the value
	 *  flows from the create front door (UI #844 / CLI) rather than a literal; defaults to `dedicated`
	 *  — a new project's first env OWNS the Fabric it provisions, so `dedicated` is the sensible
	 *  default (placing the first env as `namespace`/`vcluster` would leave the new Fabric with no
	 *  cluster owner). Preview is always `namespace` on that same Fabric. Ignored when `environments`
	 *  is provided (the full matrix carries its own placements). */
	placement_mode?: PlacementMode;
	/** The full environment matrix from the placement selector (#844). When present, the core fans it
	 *  out via {@link planFabricPlacement}: a Fabric per `dedicated` env, with every shared placement
	 *  hosted on a dedicated env's Fabric. When ABSENT the core keeps the legacy
	 *  Prod(dedicated)+Preview(namespace-on-Prod-Fabric) shape — so the CLI route and any caller that
	 *  doesn't set it are byte-identical to before. */
	environments?: EnvironmentSpec[];
	/** The creating user id — stamped on every row. */
	owner: string;
	/** The ACTIVE ORG id — rows belong to the org, not the creating user (they diverge under EE). */
	orgId: string;
}

/** The rows the front door always creates, returned so callers can seed components onto the default
 * env / render a wire response. */
export interface CreateProjectCoreResult {
	project: Project;
	defaultFabric: { id: string };
	defaultEnv: { id: string };
	previewEnv: { id: string };
}

/**
 * The project-creation front door's shared core: inserts the project row, its default **Fabric**,
 * the **Production + Preview** environments with explicit placement (Prod = `dedicated` on the new
 * Fabric; Preview = `namespace` on that same Fabric), and the project→org authz hierarchy edge.
 *
 * This is the single owner of the "default Fabric + Prod/Preview placement" invariant, called by
 * BOTH the `createProject` server action (canvas/form path) and the `POST /api/cli/projects` route
 * (CLI path) so the two can never drift. Runs entirely inside the caller-provided transaction `tx`
 * — the caller owns auth + tenancy resolution (RLS `withScope` for the action; a service-role
 * `transaction` for the CLI route) and any post-insert work (components, audit, wire response).
 *
 * The org-scoped slug select filters `org_id` EXPLICITLY so it is correct under a service-role
 * (BYPASSRLS) transaction as well as an RLS-scoped one — never rely on RLS alone for uniqueness here.
 */

/**
 * The name collision, as something a caller can catch.
 *
 * Raised by BOTH write paths — `insertProjectWithDefaultFabric` on create and `updateProjectName`
 * on rename — so a duplicate reads the same whether it was found by the pre-check or by the index
 * losing a race. Without it the caller sees drizzle's wrapper, whose message is
 * `Failed query: insert into …`, and the console answers a 500 for a thing the user can fix.
 */
export class ProjectNameTakenError extends Error {
	constructor(readonly project_name: string) {
		super(
			`A project named "${project_name}" already exists in this organization. ` +
				"Project names are unique per organization and are compared without regard to case.",
		);
		this.name = "ProjectNameTakenError";
	}
}

/** Every error in a `cause` chain, outermost first.
 *
 * Drizzle WRAPS the driver error: what a failing `.insert()` throws is a DrizzleQueryError whose
 * message is "Failed query: insert into ..." and whose `cause` is the postgres.js error carrying
 * `code` and `constraint_name`. Inspecting only the thrown object finds neither, so a check written
 * against the driver's shape silently never fires and every unique violation falls through as an
 * unmapped 500. That is not hypothetical — it is what the integration suite caught here. The depth
 * bound is paranoia about a self-referential cause, not a real chain length. */
function causeChain(err: unknown): unknown[] {
	const chain: unknown[] = [];
	let cur = err;
	for (let i = 0; i < 8 && cur !== null && cur !== undefined; i++) {
		chain.push(cur);
		if (typeof cur !== "object" || cur === null || !("cause" in cur)) break;
		// `in` narrows; no cast — CLAUDE.md §6 forbids `as`, and the narrowing is what makes the
		// read safe rather than asserted.
		const next: unknown = cur.cause;
		if (next === cur) break;
		cur = next;
	}
	return chain;
}

/** The Postgres error code, if this error or anything it wraps carries one (23505 = unique
 * violation). */
function pgErrorCode(err: unknown): string | undefined {
	for (const link of causeChain(err)) {
		if (typeof link === "object" && link !== null && "code" in link) {
			const code: unknown = link.code;
			if (typeof code === "string") return code;
		}
	}
	return undefined;
}

/** Whether this error is the project-name unique violation — exported so `updateProjectName`,
 * the other path that can mint a duplicate, maps the race onto the same error as create. */
export function isProjectNameTaken(err: unknown): boolean {
	return violates(err, "projects_org_id_project_name_key");
}

/** Whether a driver error names a particular constraint. `constraint_name` is what postgres-js
 * surfaces; the message is checked too because a wrapped error can lose the field. */
function violates(err: unknown, constraint: string): boolean {
	if (pgErrorCode(err) !== "23505") return false;
	for (const link of causeChain(err)) {
		if (typeof link !== "object" || link === null) continue;
		if ("constraint_name" in link && link.constraint_name === constraint) {
			return true;
		}
		// A wrapper that dropped the field can still name the constraint in its text. Checked
		// second, so the structured answer always wins.
		if (link instanceof Error && link.message.includes(constraint)) return true;
	}
	return false;
}

export async function insertProjectWithDefaultFabric(
	tx: Tx,
	input: CreateProjectCoreInput,
): Promise<CreateProjectCoreResult> {
	// One org-scoped read serves both uniqueness questions, and they are answered DIFFERENTLY on
	// purpose (#3145). The slug is DERIVED, so a collision is de-duplicated silently — that is what
	// `api-2` is for, and no user ever typed it. The NAME is the user's, and is the token
	// `alethia project get <name>` addresses, so a collision is REFUSED rather than quietly
	// rewritten: silently creating "api" when "api" exists gives them two projects they cannot tell
	// apart from the terminal.
	const existing = await tx
		.select({ slug: projects.slug, project_name: projects.project_name })
		.from(projects)
		.where(eq(projects.org_id, input.orgId));

	// Case-insensitive, matching `projects_org_id_project_name_key` (UNIQUE on
	// (org_id, lower(project_name))). Checking with a different predicate than the index enforces
	// is how a friendly message gets skipped and a raw 23505 reaches the user instead.
	const wanted = input.project_name.toLowerCase();
	if (existing.some((r) => r.project_name.toLowerCase() === wanted)) {
		throw new ProjectNameTakenError(input.project_name);
	}

	// Unique-per-org URL slug, skipping reserved project-child segments (e.g. "settings") so a
	// project slug can never shadow a project-scoped route.
	const takenSlugs = [
		...existing.map((r) => r.slug).filter((s): s is string => Boolean(s)),
		...RESERVED_PROJECT_CHILD_SLUGS,
	];
	const slug = pickFreeSlug(slugify(input.project_name, "project"), takenSlugs);

	// Both checks above are read-then-write inside the caller's transaction, which at READ
	// COMMITTED is optimistic: two concurrent creates of "api" both read the same rows and both
	// compute the same answer. The constraints are what actually enforce uniqueness, so the loser
	// used to surface a raw Postgres error — a bare 500 through `POST /api/cli/projects`. Mapping
	// it here means the race and the ordinary case give the SAME message.
	//
	// A name violation cannot be another tenant's: the index is keyed on (org_id, ...), so a
	// conflict is necessarily inside the caller's own org and the message leaks nothing.
	// A SLUG COLLISION MUST NOT RAISE, and that is the whole reason for `onConflictDoNothing`
	// here rather than a try/catch around a plain insert.
	//
	// This function always runs inside the CALLER's transaction — `withScope` →
	// `getAppDb().transaction(...)` on the console path, `db.transaction(...)` at
	// `app/api/cli/projects/route.ts` on the CLI path — and neither drizzle nor postgres-js opens
	// an implicit savepoint per statement. So a 23505 puts the whole transaction in the aborted
	// state, and the next command on that connection fails with 25P02 `current transaction is
	// aborted`. A retry written as catch-then-re-read therefore CANNOT succeed: it replaces a raw
	// slug violation with a stranger error, and only under the concurrency it was written for, so
	// every test with distinct names stays green over it.
	//
	// Targeting the slug constraint alone keeps the two conflicts distinguishable: a slug race
	// returns zero rows and is retried, while a NAME violation still raises and is mapped below.
	// (`onConflictDoNothing()` untargeted would swallow both and silently return nothing for a
	// duplicate name — the friendly error replaced by no error at all.)
	const insertProject = (withSlug: string) =>
		tx
			.insert(projects)
			.values({
				project_name: input.project_name,
				region: input.region,
				iac_version: input.iac_version,
				cloud_identity_id: input.cloud_identity_id ?? null,
				slug: withSlug,
				user_id: input.owner,
				org_id: input.orgId,
			})
			.onConflictDoNothing({ target: [projects.org_id, projects.slug] })
			.returning();

	let inserted: Awaited<ReturnType<typeof insertProject>>;
	try {
		inserted = await insertProject(slug);
	} catch (err) {
		if (violates(err, "projects_org_id_project_name_key")) {
			throw new ProjectNameTakenError(input.project_name);
		}
		throw err;
	}

	// Zero rows means the slug lost a race — the derived value, not the user's. The remedy is the
	// one pickFreeSlug already implements: re-read so the retry sees whatever the winner actually
	// took, rather than incrementing blindly. ONE retry, because a second miss is no longer a race
	// and a loop here would hide a real defect. The transaction is healthy at this point, which is
	// exactly what the catch-based version could not say.
	if (inserted.length === 0) {
		const now = await tx
			.select({ slug: projects.slug })
			.from(projects)
			.where(eq(projects.org_id, input.orgId));
		try {
			inserted = await insertProject(
				pickFreeSlug(slugify(input.project_name, "project"), [
					...now.map((r) => r.slug).filter((s): s is string => Boolean(s)),
					...RESERVED_PROJECT_CHILD_SLUGS,
				]),
			);
		} catch (err) {
			if (violates(err, "projects_org_id_project_name_key")) {
				throw new ProjectNameTakenError(input.project_name);
			}
			throw err;
		}
	}

	const [project] = inserted;
	if (!project) throw new Error("Failed to create project");

	// The Fabric(s) are the front door's infra units. Project-level region/cloud stay populated for
	// compatibility while downstream reads move to Fabric. Common per-Fabric values:
	const fabricBase = {
		project_id: project.id,
		user_id: input.owner,
		org_id: project.org_id,
		cloud_identity_id: input.cloud_identity_id ?? null,
		region: input.region,
		status: "DRAFT" as const,
	};

	let defaultFabric: { id: string };
	let defaultEnv: { id: string };
	let previewEnv: { id: string };

	if (input.environments && input.environments.length > 0) {
		// --- Fan-out: the full environment matrix from the placement selector (#844) ---------------
		// Placement model: a `dedicated` env OWNS its Fabric 1:1; every `namespace`/`vcluster` env is
		// placed onto the Fabric of a dedicated env, because only a dedicated env provisions a cluster.
		// Everything is `DRAFT` — no cluster is provisioned until a deploy.
		const specs = input.environments;
		// Bound the fan-out HERE, not just in the form schema — createProject doesn't re-parse the
		// client input, so the core is the real choke point against a crafted many-env request.
		if (specs.length > 8) {
			throw new Error("Too many environments (max 8).");
		}
		const defaults = specs.filter((s) => s.is_default);
		if (defaults.length !== 1) {
			throw new Error("Exactly one environment must be the default.");
		}
		for (const s of specs) {
			const problem = environmentSpecProblem(s);
			if (problem) throw new Error(problem);
		}
		// Still reserved even though the fan-out no longer mints a Fabric by this name: projects
		// created before that fix carry one, so the name would be ambiguous in a state key and in
		// `project env add --fabric shared`.
		const SHARED_FABRIC = "shared";
		if (specs.some((s) => s.name === SHARED_FABRIC)) {
			throw new Error(`"${SHARED_FABRIC}" is a reserved environment name.`);
		}
		// Unique env names — mirrors the (project_id, name) constraint so the env→Fabric map is 1:1.
		if (new Set(specs.map((s) => s.name)).size !== specs.length) {
			throw new Error("Environment names must be unique.");
		}
		// One Fabric per dedicated env; shared placements join a dedicated env's Fabric rather than a
		// Fabric of their own, because only a dedicated env provisions a cluster. See the rationale on
		// planFabricPlacement — this is the decision that used to mint an unprovisionable `shared`.
		const { fabricNames, hostFor } = planFabricPlacement(specs);
		const fabricRows = await tx
			.insert(projectFabrics)
			.values(fabricNames.map((name) => ({ ...fabricBase, name })))
			.returning({ id: projectFabrics.id, name: projectFabrics.name });
		const fabricByName = new Map(fabricRows.map((f) => [f.name, f.id]));
		const fabricFor = (s: EnvironmentSpec): string => {
			const id = fabricByName.get(hostFor(s));
			if (!id) throw new Error(`No Fabric for environment "${s.name}".`);
			return id;
		};

		const envRows = await tx
			.insert(projectEnvironments)
			.values(
				specs.map((s) => ({
					project_id: project.id,
					user_id: input.owner,
					org_id: project.org_id,
					name: s.name,
					stage: s.stage,
					status: "DRAFT" as const,
					is_default: s.is_default ?? false,
					region: input.region,
					fabric_id: fabricFor(s),
					placement_mode: s.placement_mode,
					// `dedicated` owns the whole Fabric → no namespace; shared placements carry one.
					namespace: s.placement_mode === "dedicated" ? null : (s.namespace ?? null),
					lifecycle: s.lifecycle ?? "persistent",
				})),
			)
			.returning({
				id: projectEnvironments.id,
				name: projectEnvironments.name,
				is_default: projectEnvironments.is_default,
			});

		const def = envRows.find((e) => e.is_default);
		if (!def) throw new Error("Failed to create the default environment.");
		defaultEnv = { id: def.id };
		// `previewEnv` is retained for the result contract; fall back to the default if none is named.
		previewEnv = { id: (envRows.find((e) => e.name === "preview") ?? def).id };
		defaultFabric = { id: fabricFor(defaults[0]) };
	} else {
		// --- Legacy shape (unchanged): one Fabric named after the stage; Prod(dedicated) + Preview
		// (namespace) BOTH placed on it. Byte-identical to the #900 seam so the CLI route and any
		// caller that doesn't set `environments` don't drift.
		const [fabric] = await tx
			.insert(projectFabrics)
			.values({ ...fabricBase, name: input.environment_stage })
			.returning({ id: projectFabrics.id });
		if (!fabric) throw new Error("Failed to create default Fabric");

		const [dEnv, pEnv] = await tx
			.insert(projectEnvironments)
			.values([
				{
					project_id: project.id,
					user_id: input.owner,
					org_id: project.org_id,
					name: input.environment_stage,
					stage: input.environment_stage,
					status: "DRAFT",
					is_default: true,
					region: input.region,
					fabric_id: fabric.id,
					placement_mode: input.placement_mode ?? "dedicated",
				},
				{
					project_id: project.id,
					user_id: input.owner,
					org_id: project.org_id,
					name: "preview",
					stage: "development",
					status: "DRAFT",
					is_default: false,
					region: input.region,
					fabric_id: fabric.id,
					placement_mode: "namespace",
					namespace: "preview",
				},
			])
			.returning({ id: projectEnvironments.id });
		if (!dEnv || !pEnv)
			throw new Error("Failed to create project environments");
		defaultFabric = fabric;
		defaultEnv = dEnv;
		previewEnv = pEnv;
	}

	// Authz hierarchy edge: project → org, so an org-wide grant flows down to this project.
	await tx
		.insert(resourceHierarchy)
		.values({
			child_type: "project",
			child_id: project.id,
			parent_type: "org",
			parent_id: input.orgId,
		})
		.onConflictDoNothing();
	mirrorHierarchyEdge("project", project.id, "org", input.orgId);

	return { project, defaultFabric, defaultEnv, previewEnv };
}
