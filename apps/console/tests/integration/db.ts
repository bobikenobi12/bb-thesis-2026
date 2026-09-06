// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Shared helpers for the integration suite: a one-time connectivity probe (so the suite
// SKIPS rather than fails when the dev Postgres isn't up) plus tiny seed helpers. Seeding goes
// through getServiceDb() (bypasses RLS); tests use unique ids and clean up after themselves.

import { type SQL, sql } from "drizzle-orm";
import postgres from "postgres";
import { describe } from "vitest";
import { getServiceDb } from "@/lib/db";
import { authzActivityLog, runners } from "@/lib/db/schema";

/** Probe the dev DB once; true when reachable. */
async function ping(): Promise<boolean> {
	try {
		const sql = postgres(process.env.ALETHIA_DATABASE_URL ?? "", {
			max: 1,
			idle_timeout: 1,
			connect_timeout: 3,
		});
		await sql`select 1`;
		await sql.end({ timeout: 1 });
		return true;
	} catch {
		return false;
	}
}

// Top-level await: resolves once per test file (cheap). Gates the whole suite.
export const DB_UP = await ping();

// A SILENT skip here is the whole integration tier reporting green on nothing.
//
// 55 test files import `describeIfDb`. If the probe fails, every one of them no-ops and the run
// reports success — and "Integration (real Postgres + RLS)" is a REQUIRED check, so that green tick
// would mean the RLS tenant-isolation suite did not execute, not that it passed.
//
// Today that is prevented only by ACCIDENT: `Migrate the test database` happens to run earlier in
// the CI job and reds it before the tests get a chance to skip. That is step ordering, not an
// assertion — it is invisible from this file, and it evaporates the moment those steps are made
// independent of each other, which is exactly what #2662 proposes for the sibling `guards` job.
//
// So the gate states its own requirement instead of inheriting one. This mirrors the assert-not-
// skip already written for PDP parity (pdp-parity.test.ts · ALETHIA_PDP_PARITY_REQUIRE) and the
// sandbox canaries (ALETHIA_E2E_T1_REQUIRE · ALETHIA_E2E_B6_REQUIRE): warn-and-skip for a developer
// without the stack, hard failure wherever the suite is supposed to BE the evidence.
if (!DB_UP) {
	const msg =
		"[integration] Postgres not reachable on ALETHIA_DATABASE_URL — the integration suite is SKIPPING. Run `pnpm db:up` first.";
	if (process.env.ALETHIA_INTEGRATION_REQUIRE_DB === "1") {
		throw new Error(
			`${msg} (ALETHIA_INTEGRATION_REQUIRE_DB=1 → refusing to report green on a suite that never ran)`,
		);
	}
	// eslint-disable-next-line no-console
	console.warn(`\n${msg}\n`);
}

/** `describe` that no-ops when the DB is down, so CI/dev without the stack stays green. */
export const describeIfDb = DB_UP ? describe : describe.skip;

/**
 * True when `ALETHIA_APP_DATABASE_URL` names a genuinely DIFFERENT role from the migration URL.
 *
 * It has to be different for an RLS test to mean anything: the migration role owns the tables and
 * is `BYPASSRLS`, so every isolation assertion run through it passes by construction. ~24 tests
 * across eight files gate on this, and they are the tenant-isolation suite — the "+ RLS" half of
 * this job's own name.
 *
 * IT LIVED IN EIGHT COPIES, character-identical, one per test file. That is the shape that has
 * already cost this repo a defect: two copies of a board↔PR predicate drifted and silently stopped
 * matching `Fixes #n`, which is why `scripts/lib/board-pr.sh` exists. Eight copies of a predicate
 * that decides whether the security suite runs is the same bet at four times the odds.
 */
export const APP_ROLE_DISTINCT =
	(process.env.ALETHIA_APP_DATABASE_URL ?? "") !== "" &&
	process.env.ALETHIA_APP_DATABASE_URL !== process.env.ALETHIA_DATABASE_URL;

// The same assert-not-skip, for the same reason. A reachable database with no distinct app role
// still runs every RLS test through a BYPASSRLS superuser — the suite executes, reports green, and
// asserts nothing about isolation. ci.yml's env block already says it provides a distinct role "so
// the RLS isolation assertion actually runs (not skipped)"; this is the check that the comment was
// standing in for.
if (DB_UP && !APP_ROLE_DISTINCT) {
	const msg =
		"[integration] ALETHIA_APP_DATABASE_URL is unset or identical to ALETHIA_DATABASE_URL — every RLS isolation test is SKIPPING (the migration role is BYPASSRLS, so running them through it would assert nothing).";
	if (process.env.ALETHIA_INTEGRATION_REQUIRE_DB === "1") {
		throw new Error(
			`${msg} (ALETHIA_INTEGRATION_REQUIRE_DB=1 → refusing to report green on isolation that was never tested)`,
		);
	}
	// eslint-disable-next-line no-console
	console.warn(`\n${msg}\n`);
}

/**
 * Deletes authz_activity_log rows matching `where`, under the retention-GC WORM exemption. The
 * append-only WORM trigger (authz_activity_log_worm in programmables.sql) blocks EVERY direct DELETE
 * except while `app.authz_gc = 'on'` — the flag only gc_authz_activity_log sets. Test teardown is
 * legitimate maintenance, so set that flag for the txn (exactly as the GC does) and then delete.
 * Without this the WORM raises and the suite's cleanup fails.
 */
export async function purgeAuthzActivityLog(where: SQL): Promise<void> {
	await getServiceDb().transaction(async (tx) => {
		await tx.execute(sql`select set_config('app.authz_gc', 'on', true)`);
		await tx.delete(authzActivityLog).where(where);
	});
}

/**
 * Every message in an error's `cause` chain, joined.
 *
 * drizzle WRAPS the driver error: the thrown object's own message is "Failed query: insert into …"
 * and the Postgres text — the `RAISE EXCEPTION` a trigger wrote, the constraint name — is one or
 * more `cause` links down. `expect(...).rejects.toThrow(/…/)` reads only the top message, so a test
 * written that way matches the wrapper and passes for ANY failure of that statement. That has
 * already bitten this repo once (see the `causeChain` note in lib/queries/projects.ts) and it is
 * the failure mode a refusal test can least afford.
 */
export function errorText(err: unknown): string {
	const parts: string[] = [];
	let cur: unknown = err;
	for (let i = 0; i < 8 && cur !== null && cur !== undefined; i++) {
		if (cur instanceof Error) parts.push(cur.message);
		else parts.push(String(cur));
		if (typeof cur !== "object" || cur === null || !("cause" in cur)) break;
		const next: unknown = cur.cause;
		if (next === cur) break;
		cur = next;
	}
	return parts.join(" | ");
}

/**
 * Runs `statement`, expecting the database to REFUSE it, and returns the full Postgres text (see
 * {@link errorText}) for the caller to match against. Throws if the statement succeeded — a refusal
 * test whose statement quietly worked must fail, not pass on an empty assertion.
 */
export async function refusalText(
	statement: () => PromiseLike<unknown>,
): Promise<string> {
	try {
		await statement();
	} catch (err) {
		return errorText(err);
	}
	throw new Error("expected the database to refuse this statement, but it succeeded");
}

/**
 * `is_default` for a seeded `project_environments` row: true when the project has no default yet,
 * false otherwise — evaluated in SQL, at insert time.
 *
 * Two constraints now bracket this column. `project_environments_one_default` (the partial unique
 * index) refuses a SECOND default; `project_environments_one_default_check` (the deferred
 * constraint trigger in lib/db/programmables.sql, #4127) refuses a commit in which a project has
 * environments and NONE of them is the default. So a fixture that seeds N environments one call at
 * a time has to flag exactly the first — and the seed helpers that do this are called from a dozen
 * separate tests each, with no notion of which call is first.
 *
 * Answering the question in SQL keeps that bookkeeping out of every helper. It is only correct for
 * one-row-per-statement inserts: a multi-row VALUES evaluates the subquery against the same
 * pre-statement snapshot for every row, so all of them would come back true and collide. Those
 * fixtures spell `is_default` out per row instead.
 */
export function defaultIfFirst(projectId: string): SQL<boolean> {
	return sql<boolean>`NOT EXISTS (
		SELECT 1 FROM public.project_environments e
		 WHERE e.project_id = ${projectId}::uuid AND e.is_default
	)`;
}

/** Inserts a managed runner (the FK target for jobs / usage sessions) and returns its id. */
export async function seedManagedRunner(name: string): Promise<string> {
	const [row] = await getServiceDb()
		.insert(runners)
		.values({
			name,
			operator: "managed", // managed ⇒ user_id NULL (CHECK)
			token_hash: `hash-${name}`,
			status: "OFFLINE",
		})
		.returning({ id: runners.id });
	return row.id;
}
