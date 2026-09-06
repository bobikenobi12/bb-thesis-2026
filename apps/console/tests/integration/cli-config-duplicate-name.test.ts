// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: getCliConfig resolves DETERMINISTICALLY when two projects share a name
// (#2663, then #3145).
//
// This suite exists for two reasons, and the second is the reason it is an integration test and
// not a mocked unit test.
//
// 1. `getCliConfig` took `.limit(1)` with no ORDER BY over a non-unique filter, so which project
//    the CLI resolved was undefined. #2663 imposed a total order; #3145 then made project names
//    UNIQUE per org (`projects_org_id_project_name_key`, on (org_id, lower(project_name))).
//
//    THE ORDER IS STILL LOAD-BEARING, AND THIS FIXTURE IS WHY. The constraint is per-ORG; this
//    resolver filters on `user_id` (the route: "Still scoped by user_id (community-correct;
//    threaded to org in 4.5)"). So one person who belongs to two orgs can still legitimately own
//    two projects of the same name, the resolver still sees both, and the ORDER BY is still the
//    only thing deciding which they get. The fixture therefore moved from two projects in ONE org
//    — which the database now refuses, and which is asserted below — to two projects in TWO orgs,
//    owned by one user. Same defect, same guarantee, the shape the schema still permits.
//
// 2. `lib/queries/**` is excluded from the unit coverage scope under the claim that each file is
//    "verified by the integration tier". For `lib/queries/cli-config.ts` that claim was FALSE — no
//    integration test named it, and no unit test either. It was covered by nothing, which is how a
//    resolver behind three authenticated CLI routes kept an undefined result. This file is the
//    evidence the exclusion was asserting.
//
// A mocked test could not catch either half: the ordering is real SQL, and the point at issue is
// what Postgres returns for an unordered LIMIT 1 — which a mock decides for itself.

import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getServiceDb } from "@/lib/db";
import { projectEnvironments, projects } from "@/lib/db/schema";
import { getCliConfig } from "@/lib/queries/cli-config";
import { isProjectNameTaken, ProjectNameTakenError } from "@/lib/queries/projects";
import { describeIfDb, refusalText } from "./db";

// Two orgs, one user — see the header. Same-org duplicates are refused by the database now, and
// that refusal is asserted in its own test rather than assumed.
const ORG_OLDER = randomUUID();
const ORG_NEWER = randomUUID();
const USER = randomUUID();

// The rows are inserted in the OPPOSITE order to the one they must resolve in, so a result that
// merely reflected physical insertion order would fail. (The ids are random UUIDs, so their sort
// order relative to the timestamps is not controlled — insertion order is the control here, and
// `created_at` is what the ORDER BY actually keys on.)
const OLDER = randomUUID();
const NEWER = randomUUID();
const ENV_OLDER = randomUUID();
const ENV_NEWER = randomUUID();

const SHARED_NAME = `dup-${randomUUID().slice(0, 8)}`;

const OLDER_CREATED = new Date("2026-01-01T00:00:00.000Z");
const NEWER_CREATED = new Date("2026-06-01T00:00:00.000Z");

describeIfDb("getCliConfig — two projects, one name", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		// NEWER first, so insertion order is the OPPOSITE of the expected resolution order.
		await db.insert(projects).values({
			id: NEWER,
			org_id: ORG_NEWER,
			user_id: USER,
			project_name: SHARED_NAME,
			region: "westeurope",
			iac_version: "1.0",
			slug: `${SHARED_NAME}-2`,
			created_at: NEWER_CREATED,
		});
		await db.insert(projects).values({
			id: OLDER,
			org_id: ORG_OLDER,
			user_id: USER,
			project_name: SHARED_NAME,
			region: "eu-central-1",
			iac_version: "1.0",
			slug: SHARED_NAME,
			created_at: OLDER_CREATED,
		});
		await db.insert(projectEnvironments).values({
			id: ENV_NEWER,
			project_id: NEWER,
			user_id: USER,
			name: "newer-default",
			stage: "production",
			is_default: true,
		});
		await db.insert(projectEnvironments).values({
			id: ENV_OLDER,
			project_id: OLDER,
			user_id: USER,
			name: "older-default",
			stage: "production",
			is_default: true,
		});
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db
			.delete(projectEnvironments)
			.where(inArray(projectEnvironments.project_id, [OLDER, NEWER]));
		await db.delete(projects).where(inArray(projects.id, [OLDER, NEWER]));
	});

	// Asserts through isProjectNameTaken — the predicate BOTH write paths use to turn a violation
	// into ProjectNameTakenError — rather than against the thrown message. That is deliberate and
	// it earned its keep: drizzle wraps the driver error, so the thrown object's message is
	// "Failed query: insert into ..." and `code` / `constraint_name` live on its `cause`. A test
	// matching the message text passed for the wrong reason (any failure looked like a clash) while
	// the production mapping silently never fired. Asserting the mapping tests the DB and the code
	// that reads it, together.
	async function nameClash(project_name: string, slug: string): Promise<boolean> {
		try {
			await getServiceDb().insert(projects).values({
				id: randomUUID(),
				org_id: ORG_OLDER,
				user_id: USER,
				project_name,
				region: "eu-central-1",
				iac_version: "1.0",
				slug,
			});
			return false; // inserted — the constraint did NOT fire
		} catch (err) {
			return isProjectNameTaken(err);
		}
	}

	it("REFUSES a second project of the same name in the same org", async () => {
		// The guarantee #3145 added, asserted against the real index rather than inferred from
		// the schema file. Without this the suite would silently become a test of two orgs only,
		// and the constraint that made that necessary would be covered by nothing.
		expect(await nameClash(SHARED_NAME, `${SHARED_NAME}-clash`)).toBe(true);
	});

	// The predicate is half the mapping; this is the other half. `isProjectNameTaken` says a
	// violation happened, and `ProjectNameTakenError` is what both write paths raise in its
	// place — the thing a caller actually catches, and the only reason the driver error is
	// mapped at all. Asserting it here keeps the two ends of that mapping in one suite: a
	// predicate that fires and an error nobody constructs is a fix that surfaces as a 500.
	it("...and the error a caller sees names the project, not the query that failed", () => {
		const err = new ProjectNameTakenError(SHARED_NAME);
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("ProjectNameTakenError");
		expect(err.message).toContain(SHARED_NAME);
		// The message drizzle would otherwise surface. It is the one this class exists to replace.
		expect(err.message).not.toMatch(/Failed query|insert into/i);
	});

	it("REFUSES a same-org name that differs only in CASE", async () => {
		// The index is on lower(project_name), so this must fail for the same reason. Asserted
		// separately because a plain unique on the bare column would pass the test above and fail
		// this one — which is exactly the difference the migration chose deliberately.
		expect(await nameClash(SHARED_NAME.toUpperCase(), `${SHARED_NAME}-case`)).toBe(true);
	});

	it("resolves the OLDEST project, not an arbitrary one", async () => {
		const cfg = await getCliConfig(getServiceDb(), {
			userId: USER,
			projectName: SHARED_NAME,
		});
		expect(cfg).not.toBeNull();
		expect(cfg?.id).toBe(OLDER);
		// The region is what a user would actually notice resolving to the wrong project: it is the
		// field the CLI hands onward.
		expect(cfg?.region).toBe("eu-central-1");
	});

	it("returns the same project on repeated calls (no per-call variation)", async () => {
		// WHAT THIS DOES AND DOES NOT CATCH — stated precisely, because a test that overstates its
		// strength is how the next reader concludes the ordering is covered when it is not.
		//
		// Five identical sequential queries in one session are the SAME draw five times, not five
		// independent ones: Postgres will almost certainly return the same row each time even with
		// no ORDER BY, so this loop is NOT what discriminates. The assertion that actually does is
		// the one above — the rows are inserted in the OPPOSITE order to the expected resolution,
		// so a result reflecting physical order fails.
		//
		// This case earns its place for a narrower reason: it catches per-call VARIATION — a cache
		// or memoisation between calls returning a different row on a later invocation.
		const ids = new Set<string>();
		for (let i = 0; i < 5; i += 1) {
			const cfg = await getCliConfig(getServiceDb(), {
				userId: USER,
				projectName: SHARED_NAME,
			});
			if (cfg) ids.add(cfg.id);
		}
		expect([...ids]).toEqual([OLDER]);
	});

	it("still honours an explicit envId, and refuses one from another project", async () => {
		const mine = await getCliConfig(getServiceDb(), {
			userId: USER,
			projectName: SHARED_NAME,
			envId: ENV_OLDER,
		});
		expect(mine?.environment_stage).toBe("older-default");

		// ENV_NEWER belongs to the OTHER project. `envs` is already scoped to the resolved
		// project, so this must miss rather than cross the boundary — asserted so a future
		// refactor that "helpfully" widens the environment lookup is caught here.
		const crossed = await getCliConfig(getServiceDb(), {
			userId: USER,
			projectName: SHARED_NAME,
			envId: ENV_NEWER,
		});
		expect(crossed).toBeNull();
	});

	it("returns null for another user's project of the same name", async () => {
		const other = await getCliConfig(getServiceDb(), {
			userId: randomUUID(),
			projectName: SHARED_NAME,
		});
		expect(other).toBeNull();
	});

	// This test used to assert the OPPOSITE, and the inversion is the point of #4127.
	//
	// It cleared `is_default` on the resolved project's only environment, added an older one, and
	// then asserted that `getCliConfig` fell back to the earliest row *deterministically* — the
	// half-measure #2663 could offer while the schema still permitted zero defaults. A deterministic
	// arbitrary pick is still an arbitrary pick: the CLI, the project header and the deploy target
	// each ran their own version of it, and nothing said they had to agree.
	//
	// `project_environments_one_default_check` (lib/db/programmables.sql) now refuses to COMMIT that
	// state, so the fallback has no reachable input and was deleted. What is asserted instead is
	// that the state cannot be created — which is the guarantee the deleted fallback was standing in
	// for. It runs through the SERVICE connection (BYPASSRLS): the check is a trigger, and triggers
	// are not bypassed by BYPASSRLS, so this also pins that the invariant binds the most privileged
	// caller the app has.
	it("the database refuses to leave a project's environments without a default", async () => {
		const db = getServiceDb();
		// `rejects.toThrow` would read drizzle's WRAPPER message ("Failed query: update …") and match
		// any failure of this statement at all; refusalText walks the cause chain to the Postgres text.
		expect(
			await refusalText(() =>
				db
					.update(projectEnvironments)
					.set({ is_default: false })
					.where(eq(projectEnvironments.id, ENV_OLDER)),
			),
		).toMatch(/exactly one must have is_default/);

		// And the row is untouched — the failed statement rolled back, so the resolver still answers.
		const cfg = await getCliConfig(getServiceDb(), {
			userId: USER,
			projectName: SHARED_NAME,
		});
		expect(cfg?.environment_stage).toBe("older-default");
	});
});
