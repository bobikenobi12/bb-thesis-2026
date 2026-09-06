// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (real Postgres): `project_environments_one_default_check` — the deferred constraint
// trigger that turns "at most one default environment" into EXACTLY one (#4127).
//
// The partial unique index `project_environments_one_default` has always given at-most-one. It says
// nothing about zero, which is why three readers carried `find(is_default) ?? envs[0]` — an
// arbitrary row presented as an answer, and three chances for the CLI, the project header and the
// deploy target to name different environments while all three looked authoritative.
//
// WHY THIS IS AN INTEGRATION TEST AND NOT A UNIT TEST. Every claim below is a property of Postgres:
// when a DEFERRABLE INITIALLY DEFERRED constraint trigger runs, what an ON DELETE CASCADE does to
// it, and whether a SECURITY DEFINER probe sees rows an RLS policy would hide. A mock decides all
// three for itself and would agree with whatever this file asserted.
//
// TIMING IS THE POINT, AND A TEST THAT ONLY CHECKS THE END STATE CANNOT SEE IT. An IMMEDIATE
// trigger and a DEFERRED one leave the same rows behind; they differ only in WHEN they judge — and
// an immediate one would break project creation, which inserts the `projects` row in one statement
// and its environments in the next. So the deferral is asserted directly, twice: once by committing
// a transaction that passes through an invalid intermediate state, and once by proving the
// offending statement itself SUCCEEDS and only the COMMIT fails.

import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, expect, it } from "vitest";
import { getServiceDb, withOwnerScope } from "@/lib/db";
import { projectEnvironments, projects } from "@/lib/db/schema";
import { APP_ROLE_DISTINCT, describeIfDb, refusalText } from "./db";

const OWNER = randomUUID();

/** Every project this file creates, so the teardown can sweep them by cascade. */
const created: string[] = [];

/** Inserts a bare project (no environments) through the service connection; returns its id. */
async function newProject(): Promise<string> {
	const id = randomUUID();
	await getServiceDb().insert(projects).values({
		id,
		user_id: OWNER,
		org_id: OWNER,
		project_name: `one-default-${id.slice(0, 8)}`,
		region: "eu-central-1",
		iac_version: "1.0",
	});
	created.push(id);
	return id;
}

/** The `values()` payload for one environment of `projectId`. */
function env(projectId: string, name: string, isDefault: boolean) {
	return {
		id: randomUUID(),
		project_id: projectId,
		user_id: OWNER,
		org_id: OWNER,
		name,
		stage: "production" as const,
		is_default: isDefault,
	};
}

describeIfDb("project_environments — exactly one default", () => {
	afterAll(async () => {
		if (created.length > 0) {
			await getServiceDb().delete(projects).where(inArray(projects.id, created));
		}
	});

	// ── The shape of the guard, not just its effect ────────────────────────────────────────────
	//
	// Asserted against the catalog rather than inferred from behaviour, because the two properties
	// that matter most are exactly the ones a behavioural test cannot distinguish on a healthy
	// database: an IMMEDIATE trigger passes most of the cases below, and a SECURITY INVOKER probe
	// agrees with a definer one for as long as `project_environments`'s RLS policy keeps deriving
	// from `projects` visibility. Both are silent, one-line regressions in programmables.sql.
	it("is a DEFERRABLE INITIALLY DEFERRED constraint trigger on a SECURITY DEFINER function", async () => {
		const rows = await getServiceDb().execute(sql`
			select (t.tgconstraint <> 0)                          as is_constraint_trigger,
			       t.tgdeferrable                                 as is_deferrable,
			       t.tginitdeferred                               as is_initially_deferred,
			       p.prosecdef                                    as is_security_definer,
			       coalesce(array_to_string(p.proconfig, ','), '') as fn_config
			  from pg_trigger t
			  join pg_proc p on p.oid = t.tgfoid
			 where t.tgname = 'project_environments_one_default_check'
			   and not t.tgisinternal
		`);
		const row = rows[0];
		expect(row, "the trigger is missing — has programmables.sql been applied?").toBeDefined();
		expect(row?.is_constraint_trigger).toBe(true);
		expect(row?.is_deferrable).toBe(true);
		expect(row?.is_initially_deferred).toBe(true);
		// SECURITY DEFINER: the parent-exists probe and the default count must see the REAL rows.
		// Under invoker rights an RLS policy that hid either one would make the check skip silently —
		// a fail-open invariant, which is worse than none once the readers are rewritten to trust it.
		expect(row?.is_security_definer).toBe(true);
		expect(String(row?.fn_config)).toContain("search_path=public");
		expect(String(row?.fn_config)).toContain("row_security=off");
	});

	// ── Deferral, proved two ways ──────────────────────────────────────────────────────────────
	it("is DEFERRED: a transaction may pass through a default-less state and still commit", async () => {
		const projectId = await newProject();
		const row = env(projectId, "prod", false);
		// Under an IMMEDIATE trigger this insert alone raises and the test fails here.
		await getServiceDb().transaction(async (tx) => {
			await tx.insert(projectEnvironments).values(row);
			await tx
				.update(projectEnvironments)
				.set({ is_default: true })
				.where(eq(projectEnvironments.id, row.id));
		});
		const after = await getServiceDb()
			.select({ is_default: projectEnvironments.is_default })
			.from(projectEnvironments)
			.where(eq(projectEnvironments.project_id, projectId));
		expect(after).toEqual([{ is_default: true }]);
	});

	it("fires at COMMIT and not at the statement", async () => {
		const projectId = await newProject();
		// The discriminator. `rejects.toThrow` alone would pass for an immediate trigger too — it is
		// this flag that says the offending statement RETURNED and the transaction was still healthy
		// afterwards, which only a deferred check allows.
		let statementSucceeded = false;
		const text = await refusalText(() =>
			getServiceDb().transaction(async (tx) => {
				await tx.insert(projectEnvironments).values(env(projectId, "prod", false));
				// Still usable: an immediate raise would have aborted the transaction and this would
				// fail with 25P02 instead of returning.
				await tx.execute(sql`select 1`);
				statementSucceeded = true;
			}),
		);
		expect(text).toMatch(/exactly one must have is_default/);
		expect(statementSucceeded).toBe(true);

		// Rolled back whole: the failed COMMIT left nothing behind.
		const after = await getServiceDb()
			.select({ id: projectEnvironments.id })
			.from(projectEnvironments)
			.where(eq(projectEnvironments.project_id, projectId));
		expect(after).toHaveLength(0);
	});

	// ── The paths that must keep working ───────────────────────────────────────────────────────
	it("permits the create shape: the project row first, its environments in a later statement", async () => {
		// `insertProjectWithDefaultFabric` (lib/queries/projects.ts) does exactly this — the project
		// exists with zero environments for the middle of its own transaction.
		const projectId = randomUUID();
		created.push(projectId);
		await getServiceDb().transaction(async (tx) => {
			await tx.insert(projects).values({
				id: projectId,
				user_id: OWNER,
				org_id: OWNER,
				project_name: `create-shape-${projectId.slice(0, 8)}`,
				region: "eu-central-1",
				iac_version: "1.0",
			});
			await tx
				.insert(projectEnvironments)
				.values([env(projectId, "prod", true), env(projectId, "preview", false)]);
		});
		const after = await getServiceDb()
			.select({ is_default: projectEnvironments.is_default })
			.from(projectEnvironments)
			.where(eq(projectEnvironments.project_id, projectId));
		expect(after).toHaveLength(2);
		expect(after.filter((e) => e.is_default)).toHaveLength(1);
	});

	it("permits deleting a project — the cascade takes its environments with it", async () => {
		// THE REASON THIS TRIGGER WAS NOT BUNDLED INTO #3145. `project_environments.project_id`
		// cascades, so an AFTER DELETE check that ran per statement would demand a default from a
		// project that is being deleted and block every project deletion. Deferred, the parent row is
		// gone by the time the check runs and the NOT EXISTS probe skips.
		const projectId = await newProject();
		await getServiceDb()
			.insert(projectEnvironments)
			.values([env(projectId, "prod", true), env(projectId, "preview", false)]);

		await expect(
			getServiceDb().delete(projects).where(eq(projects.id, projectId)),
		).resolves.toBeDefined();

		const orphans = await getServiceDb()
			.select({ id: projectEnvironments.id })
			.from(projectEnvironments)
			.where(eq(projectEnvironments.project_id, projectId));
		expect(orphans).toHaveLength(0);
	});

	it("leaves a project with NO environments alone (deliberately out of scope)", async () => {
		// The predicate is "a project's environments, IF IT HAS ANY, contain exactly one default".
		// "Every project has at least one environment" is a strictly larger invariant and is not this
		// unit's; the readers already treat "no environments" as a distinct, reported outcome rather
		// than something to guess around. Pinned so a future widening is a deliberate change here.
		const projectId = await newProject();
		const rows = await getServiceDb()
			.select({ id: projectEnvironments.id })
			.from(projectEnvironments)
			.where(eq(projectEnvironments.project_id, projectId));
		expect(rows).toHaveLength(0);
	});

	// ── The states that are now refused ────────────────────────────────────────────────────────
	it("refuses a project's first environment when it is not the default", async () => {
		const projectId = await newProject();
		const text = await refusalText(() =>
			getServiceDb().insert(projectEnvironments).values(env(projectId, "prod", false)),
		);
		expect(text).toMatch(/exactly one must have is_default/);
		// The message names the project, so an operator reading a failed migrate or a 500 knows which.
		expect(text).toContain(projectId);
	});

	it("refuses clearing the only default", async () => {
		const projectId = await newProject();
		const only = env(projectId, "prod", true);
		await getServiceDb().insert(projectEnvironments).values(only);
		expect(
			await refusalText(() =>
				getServiceDb()
					.update(projectEnvironments)
					.set({ is_default: false })
					.where(eq(projectEnvironments.id, only.id)),
			),
		).toMatch(/exactly one must have is_default/);
	});

	it("refuses deleting the default while other environments remain", async () => {
		const projectId = await newProject();
		const def = env(projectId, "prod", true);
		await getServiceDb()
			.insert(projectEnvironments)
			.values([def, env(projectId, "preview", false)]);
		expect(
			await refusalText(() =>
				getServiceDb().delete(projectEnvironments).where(eq(projectEnvironments.id, def.id)),
			),
		).toMatch(/exactly one must have is_default/);
	});

	it("checks BOTH ends when an environment moves between projects", async () => {
		// An UPDATE of project_id can break the invariant at the project it leaves as well as the one
		// it joins, so the trigger checks OLD and NEW. Here the SOURCE is the one left broken — a
		// check that only looked at NEW.project_id would let this through.
		const source = await newProject();
		const target = await newProject();
		const def = env(source, "prod", true);
		await getServiceDb()
			.insert(projectEnvironments)
			.values([def, env(source, "preview", false)]);

		const text = await refusalText(() =>
			getServiceDb()
				.update(projectEnvironments)
				.set({ project_id: target })
				.where(eq(projectEnvironments.id, def.id)),
		);
		// It is the SOURCE that ends up broken; a check that only looked at NEW.project_id would have
		// let this commit. The raised message names the offending project, so assert on that id
		// rather than merely on the fact that something failed.
		expect(text).toMatch(new RegExp(`project ${source} has 1 environment\\(s\\) but 0 default`));
	});

	// ── The least-privileged role ──────────────────────────────────────────────────────────────
	//
	// Every console write arrives on `alethia_app` with RLS enforced. These run there because the
	// SECURITY DEFINER probe exists for this connection and no other: if the check could be made to
	// skip by a policy, this is where it would happen, and the fallbacks removed in this same change
	// would have been deleted on a promise the database did not keep.
	it.skipIf(!APP_ROLE_DISTINCT)(
		"binds the RLS-enforced app connection too",
		async () => {
			const projectId = randomUUID();
			created.push(projectId);
			await withOwnerScope(OWNER, (tx) =>
				tx.insert(projects).values({
					id: projectId,
					user_id: OWNER,
					org_id: OWNER,
					project_name: `app-role-${projectId.slice(0, 8)}`,
					region: "eu-central-1",
					iac_version: "1.0",
				}),
			);

			expect(
				await refusalText(() =>
					withOwnerScope(OWNER, (tx) =>
						tx.insert(projectEnvironments).values(env(projectId, "prod", false)),
					),
				),
			).toMatch(/exactly one must have is_default/);

			// …and the valid write still lands, so the guard is not simply refusing everything.
			await withOwnerScope(OWNER, (tx) =>
				tx.insert(projectEnvironments).values(env(projectId, "prod", true)),
			);
			const rows = await getServiceDb()
				.select({ is_default: projectEnvironments.is_default })
				.from(projectEnvironments)
				.where(eq(projectEnvironments.project_id, projectId));
			expect(rows).toEqual([{ is_default: true }]);
		},
	);

	it.skipIf(!APP_ROLE_DISTINCT)(
		"still lets the app connection delete a project (cascade + RLS together)",
		async () => {
			const projectId = randomUUID();
			await withOwnerScope(OWNER, async (tx) => {
				await tx.insert(projects).values({
					id: projectId,
					user_id: OWNER,
					org_id: OWNER,
					project_name: `app-del-${projectId.slice(0, 8)}`,
					region: "eu-central-1",
					iac_version: "1.0",
				});
				await tx
					.insert(projectEnvironments)
					.values([env(projectId, "prod", true), env(projectId, "preview", false)]);
			});

			await expect(
				withOwnerScope(OWNER, (tx) => tx.delete(projects).where(eq(projects.id, projectId))),
			).resolves.toBeDefined();

			const left = await getServiceDb()
				.select({ id: projects.id })
				.from(projects)
				.where(eq(projects.id, projectId));
			expect(left).toHaveLength(0);
		},
	);
});
