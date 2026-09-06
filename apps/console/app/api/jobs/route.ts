// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from "crypto";
import { signedJob } from "@/lib/db/signed-job";
import { type SQL, eq, inArray, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import {
	destroyProject,
	planProject,
	provisionProject,
} from "@/app/server/actions/projects";
import { emitAlertEventSafe } from "@/lib/alerts/emit";
import { getActiveScope } from "@/lib/auth/scope";
import { runWithActor } from "@/lib/authz/actor-context";
import { authorizeCli, ensureCliOrgAccess } from "@/lib/authz/guard";
import { assertRunnerInOrg } from "@/lib/authz/runner-org";
import { ForbiddenError } from "@/lib/authz/types";
import { assertJobQuotaAllowed } from "@/lib/billing/job-quota";
import { verifyCliToken } from "@/lib/cli/auth";
import {
	type CursorScope,
	cursorKey,
	paginate,
	parsePageOpts,
} from "@/lib/cli/paging";
import { cliJson } from "@/lib/cli/respond";
import { getServiceDb } from "@/lib/db";
import { jobs, runners, projects } from "@/lib/db/schema";
import { notifyScaler } from "@/lib/scaler";
import { cliJobResponse, cliJobsPageResponse } from "@/lib/validations/cli-contract";

// Job types the CLI is allowed to queue through this endpoint (a subset of the
// full provision_job_type enum — runner-lifecycle types are created elsewhere).
type CreatableJobType = "DEPLOY" | "DESTROY" | "PLAN" | "DESTROY_RUNNER";

/** Narrows an untrusted body value to a CreatableJobType (no cast). */
function parseJobType(v: unknown): CreatableJobType | null {
	switch (v) {
		case "DEPLOY":
		case "DESTROY":
		case "PLAN":
		case "DESTROY_RUNNER":
			return v;
		default:
			return null;
	}
}

/**
 * Queues a provisioning job for the CLI user, snapshotting the project config.
 *
 * PLAN/DEPLOY/DESTROY delegate to the same server actions the console uses
 * (planProject/provisionProject/destroyProject) under the caller's actor
 * (runWithActor — the MCP seam), so a CLI-queued job freezes the SAME nested
 * `buildConfigSnapshot` shape (provider, environment_stage, cluster, dns,
 * addons, placement-resolved components) the Go runner deserializes into
 * ProjectConfig — a nested, placement-resolved snapshot, not a flat per-table row.
 *
 * TENANCY (#3874). Every verb resolves the caller's org before it branches, and the
 * DESTROY_RUNNER insert stamps `jobs.org_id` EXPLICITLY rather than letting the
 * `set_org_id_from_project` trigger fall through. On `getServiceDb()` — a role that
 * bypasses RLS and sets no `app.current_org` — that fallback stamps `NEW.user_id`, so a
 * member of a Teams org filed runner jobs into a personal tenancy nobody looks at. The
 * stamp is always the active org. `claim_next_job` carries the narrow compatibility for
 * pre-#3874 caller-owned runners, so quota, visibility, evidence, and lifecycle serialization
 * remain attached to the tenant where the action was authorized.
 * PLAN/DEPLOY/DESTROY are unaffected: they insert through the server actions under
 * `withActorScope`, where the GUC is set and the job derives its org from its project.
 */
export async function POST(req: Request) {
	const { payload, error: authError } = await verifyCliToken(req);
	if (authError) return authError;

	const userId = payload?.sub;
	if (!userId) {
		return NextResponse.json({ error: "Invalid token payload" }, { status: 401 });
	}

	try {
		const body = await req.json();
		const {
			job_type,
			configuration_id,
			cloud_identity_id,
			config_snapshot,
			assigned_runner_id,
			plan_job_id,
			// #837: optional per-environment target. When omitted the server actions fall back to
			// the project's default environment (unchanged back-compat). The CLI wire that sends
			// this is #843; here we only accept + thread it into the placement-aware dispatch.
			environment_id,
		} = body;

		if (!job_type) {
			return NextResponse.json(
				{ error: "job_type is required" },
				{ status: 400 },
			);
		}

		const jobType = parseJobType(job_type);
		if (!jobType) {
			return NextResponse.json(
				{
					error: "job_type must be one of: DEPLOY, DESTROY, PLAN, DESTROY_RUNNER",
				},
				{ status: 400 },
			);
		}

		if ((jobType === "DEPLOY" || jobType === "PLAN") && !configuration_id) {
			return NextResponse.json(
				{ error: "configuration_id is required for DEPLOY and PLAN jobs" },
				{ status: 400 },
			);
		}

		if (jobType === "DESTROY" && !configuration_id) {
			return NextResponse.json(
				{ error: "configuration_id is required for DESTROY jobs" },
				{ status: 400 },
			);
		}

		const db = getServiceDb();

		// EVERY verb resolves its scope here, ABOVE the DESTROY_RUNNER branch (#3874).
		// A SERVICE TOKEN'S ORG WINS OVER THE HEADER, and over the caller's default scope.
		//
		// This route provisions and tears down real cloud infrastructure — and it resolves its
		// own scope rather than going through `authorizeCli`. Without this, a token minted for
		// one org could drive a deploy in another whenever its creator belonged to both: not a
		// cross-tenant escalation, but a containment promise the product makes and would not
		// have kept.
		//
		// This used to sit BELOW the DESTROY_RUNNER branch, so that verb — which destroys a
		// runner — honoured neither `X-Alethia-Org` nor a service token's org pin, and the
		// comment above was true of three of the route's four verbs. Hoisting it is what makes
		// the promise cover the fourth.
		//
		// verifyCliToken already refuses a mismatched header before we get here; the fallback below
		// is what stops an ABSENT header resolving the creator's default org instead.
		const pinnedOrg =
			typeof payload?.service_token_org_id === "string" ? payload.service_token_org_id : undefined;
		const headerOrg = pinnedOrg ?? req.headers.get("X-Alethia-Org")?.trim();
		const actor = await getActiveScope(userId, headerOrg || undefined);
		if (headerOrg) {
			const denied = await ensureCliOrgAccess(actor, userId, headerOrg);
			if (denied) return denied;
		}

		if (jobType === "DESTROY_RUNNER") {
			// Runner teardown has no project config to snapshot — the client sends the
			// runner descriptor as the snapshot. Fail closed (404) on a cross-org /
			// non-existent runner so we never queue an unclaimable job.
			//
			// Keep the job in the active tenant. Pre-#3874 caller-owned runners are admitted
			// only by claim_next_job's lifecycle-only compatibility predicate.
			if (assigned_runner_id) {
				try {
					// The caller's personal id admits only their own pre-#3874 runner row.
					await assertRunnerInOrg(db, assigned_runner_id, actor.orgId, userId);
				} catch (e: unknown) {
					if (e instanceof ForbiddenError) {
						return NextResponse.json(
							{ error: "Runner not found or unauthorized" },
							{ status: 404 },
						);
					}
					throw e;
				}
			}
			await assertJobQuotaAllowed(actor.orgId);

			const [job] = await db
				.insert(jobs)
				.values(signedJob({
					user_id: userId,
					// Explicit, so the set_org_id_from_project trigger's `NEW.org_id IS NULL`
					// fallback (→ `NEW.user_id`, since getServiceDb() sets no app.current_org GUC
					// and this row has no project) never runs. That fallback IS the defect.
					org_id: actor.orgId,
					environment_id: null,
					cloud_identity_id: cloud_identity_id || null,
					job_type: jobType,
					initiated_by: "user",
					project_id: null,
					config_snapshot: config_snapshot || {},
					configuration_hash: null,
					status: "QUEUED",
					assigned_runner_id: assigned_runner_id || null,
					plan_job_id: plan_job_id || null,
				}))
				.returning();

			notifyScaler();
			return cliJson(cliJobResponse, { job }, { status: 201 });
		}

		// PLAN / DEPLOY / DESTROY: run the console's own server actions under the CLI
		// caller's actor (resolved above). The actions authorize via the PDP, freeze the nested
		// buildConfigSnapshot, insert the job, flip the env status, audit, and notify
		// the scaler — identical to a console-queued job.
		let jobId: string;
		try {
			const result = await runWithActor(actor, async () => {
				switch (jobType) {
					case "PLAN":
						return planProject(
							configuration_id,
							assigned_runner_id || null,
							environment_id || null,
						);
					case "DEPLOY":
						return provisionProject(
							configuration_id,
							plan_job_id || undefined,
							assigned_runner_id || null,
							environment_id || null,
						);
					case "DESTROY":
						return destroyProject(
							configuration_id,
							environment_id || null,
							assigned_runner_id || null,
						);
				}
			});
			jobId = result.jobId;
		} catch (e: unknown) {
			// The PDP denies both "not yours" and "does not exist" — keep the CLI's
			// historical 404 contract for that case.
			if (e instanceof ForbiddenError) {
				return NextResponse.json(
					{ error: "Configuration not found or unauthorized" },
					{ status: 404 },
				);
			}
			throw e;
		}

		const [inserted] = await db
			.select()
			.from(jobs)
			.where(eq(jobs.id, jobId))
			.limit(1);
		if (!inserted) {
			return NextResponse.json({ error: "Job not found after queue" }, { status: 500 });
		}

		// Preserve the CLI plan→apply drift guard: the runner compares the PLAN job's
		// configuration_hash against the DEPLOY job's before applying.
		const configHash = createHash("sha256")
			.update(JSON.stringify(inserted.config_snapshot))
			.digest("hex");
		const [job] = await db
			.update(jobs)
			.set({ configuration_hash: configHash })
			.where(eq(jobs.id, jobId))
			.returning();

		// Ops alert (free): a teardown was requested. org_id is trigger-populated on insert.
		if (jobType === "DESTROY" && job.org_id) {
			emitAlertEventSafe(job.org_id, "system.job.destroy_requested", {
				title: "Destroy requested",
				severity: "warning",
				job_id: job.id,
				job_type: "DESTROY",
				project_id: configuration_id,
			});
		}

		return cliJson(cliJobResponse, { job }, { status: 201 });
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}

/** The collection name a `/api/jobs` cursor is bound to. See {@link CursorScope}. */
const JOBS_LIST = "jobs";

/** `?mine=` spellings that mean yes. A bare `?mine` arrives as the empty string. */
const MINE_TRUE = new Set(["", "true", "1"]);
/** `?mine=` spellings that mean no. Anything outside either set is a 400, never a silent no. */
const MINE_FALSE = new Set(["false", "0"]);

/**
 * Parses `?mine=`.
 *
 * NEITHER SET HAS A FALL-THROUGH. `?mine=yes` is a caller who believes they asked for their own
 * jobs; answering it with the whole org's is a wrong answer that looks like a right one, and the
 * flag exists precisely to make that distinction visible. So an unrecognised spelling is refused
 * rather than coerced, and the empty string — what `?mine` with no value produces — is the bare
 * flag, which is what a shell user types.
 */
function parseMine(raw: string | null): { ok: true; mine: boolean } | { ok: false } {
	if (raw === null) return { ok: true, mine: false };
	const v = raw.trim().toLowerCase();
	if (MINE_TRUE.has(v)) return { ok: true, mine: true };
	if (MINE_FALSE.has(v)) return { ok: true, mine: false };
	return { ok: false };
}

/** Parses the legacy `?offset=`: a non-negative integer, or absent. */
function parseOffset(raw: string | null): { ok: true; offset: number } | { ok: false } {
	if (raw === null || raw === "") return { ok: true, offset: 0 };
	if (!/^\d+$/.test(raw)) return { ok: false };
	const n = Number(raw);
	return Number.isSafeInteger(n) ? { ok: true, offset: n } : { ok: false };
}

function badRequest(error: string): NextResponse {
	return NextResponse.json({ error }, { status: 400 });
}

/**
 * Lists every job the caller can see — their org's and their own — cursor-paged, with the project
 * and runner names joined.
 *
 * THE SCOPE IS ONE COLUMN: `org_id in (<caller's org>, <caller's personal org>)` (#3672). This
 * route used to filter on `jobs.user_id = <caller>`, so `alethia jobs list` and the console's jobs
 * page — `getJobsPage`, which reads through RLS — answered the same question differently: a
 * teammate's deploy of the org's own project was invisible from the terminal and plainly listed in
 * the browser. One product, two surfaces, two answers.
 *
 * THE FIRST FIX FOR THAT WAS A DISJUNCTION, AND IT WAS A CROSS-TENANT LEAK. It wrote out the
 * `owner_all` RLS policy (programmables.sql:885-889) verbatim — `org_id = <caller's org> OR
 * user_id = <caller>` — on the reasoning that quoting the policy the console reads through is the
 * only way to get the policy's answer while the service role bypasses RLS.
 *
 * The flaw is that the two are not evaluated against the same subject. RLS sets
 * `app.current_owner` from the SESSION's human. Here, for a service token, `actor.userId` is the
 * person who MINTED the credential — `authorizeCli` builds `getActiveScope(mintingUserId,
 * pinnedOrg)` — and that person may belong to many orgs. So the second arm, unbounded by org,
 * returned their jobs from every one of them: a consultant in two client orgs mints a token for
 * client A's CI and A's pipeline lists client B's job names and `config_snapshot`s. The pin is
 * re-checked on every request in `lib/authz/guard.ts` precisely to stop a token acting outside its
 * tenant, and this walked past it. A policy quoted out of its enforcement context is not the same
 * statement.
 *
 * The org list is the same row set the owner arm was actually FOR (see below) and expressible on
 * `org_id` alone, which keeps the tenancy boundary one column wide — there is no second arm for a
 * caller's identity to widen it through. It also lets the keyset walk use `idx_jobs_org_cursor`:
 * an `OR` across two columns plans an unordered BitmapOr, so every page would re-sort.
 *
 * THE OWNER ARM IS NOT DECORATION, AND THE REASON IS A DATA DEFECT. `jobs.org_id` is stamped on
 * insert by `jobs_set_org_id` → `set_org_id_from_project` (programmables.sql:827-841): parent
 * project's org, else the `app.current_org` GUC, else `NEW.user_id`. Two shipped enqueue paths
 * reached that last fallback — the `DESTROY_RUNNER` branch of this file's POST, and
 * `/api/cli/runners/deploy` — because both insert a project-less job on `getServiceDb()`, which
 * sets no GUC. Those rows carry `org_id = <userId>`, the caller's PERSONAL org, so for a member
 * of a Teams org an `org_id`-only WHERE clause hides the caller's OWN runner jobs, and `?mine=`
 * could not recover them while it was ANDed onto that clause.
 *
 * That personal-org stamp is a defect at the ENQUEUE SITES, not a paging one, and #3874 has since
 * fixed it there (#3942): both inserts now stamp `org_id` EXPLICITLY. IT STAMPS FORWARD ONLY —
 * that change ships no backfill — so every job those two paths enqueued before it still carries
 * `org_id = <userId>`. Naming that id as a second ORG in the list is what keeps that history
 * listed, and it stays correct after those rows stop existing: the caller's personal org is a real
 * org they are the sole member of, so listing it is not a widening.
 *
 * `?mine=true` NARROWS THE ORG SCOPE, IT DOES NOT REPLACE IT. `user_id = <caller> AND org_id in
 * (...)` — "my jobs in this org", not "my jobs anywhere". Replacing the scope with `user_id`
 * alone is the same leak as the old default arm reached through the flag instead.
 *
 * The earlier worry — that ANDing the org back on drops the personal-org rows — was about
 * `org_id = <caller's org>` alone. It does not apply to the list: a personal org's id IS the
 * caller's user id, so those rows are INSIDE the scope, not excluded by it. That is what makes the
 * AND free. Being a
 * scope predicate rather than a post-filter, it moves `total` and `page.total` with the rows; a
 * count taken from a different set of predicates than the rows is the defect the console's filter
 * standard exists to prevent.
 *
 * `jobs.org_id` is declared nullable and holds pre-trigger history that the migrations backfill
 * rather than the schema forbid, which is a second reason this is a WHERE clause and not an
 * assumption that every row has one.
 *
 * `X-Alethia-Org` NOW APPLIES HERE. The GET resolved the caller's default scope and consulted no
 * policy at all; it goes through `authorizeCli` like every sibling CLI job route, so the header
 * (the `--org` flag), the service-token org pin that refuses a conflicting header, and the
 * `view job` decision all reach this list. That is strictly more checking than before, not less.
 *
 * PAGING: CURSOR, WITH `?offset=` STILL HONOURED. `page` is the shared vocabulary
 * (`lib/cli/paging.ts`) and `?cursor=` is the mechanism the CLI's paginated table is being built
 * onto (#3667). Until that lands, `apps/cli/cmd/jobs_table.go:40` still walks this endpoint by
 * offset, and an offset the server quietly ignored would page the same rows forever — so the
 * legacy parameter keeps working and is simply one more clause on the same query. The two cannot
 * be combined: "skip 20 rows after this position" is a question no caller means to ask, and
 * answering it would hide whichever of the two the caller thought was in effect.
 *
 * TWO NUMBERS MOVED WITH THE CONVERSION, both widening and both echoed back in `page.limit`:
 * `?limit=` now defaults to 50 rather than 20 and clamps at 200 rather than 100, because those
 * are the vocabulary's shared bounds and a second set here would be a second contract. Every
 * shipped caller sends an explicit limit, so the default is reachable only by a hand-written
 * request. What a caller must NOT do is compute a page count from `total` without reading
 * `page.mode`: an exact `count(*)` per page was the full scan the cap exists to remove, so past
 * DEFAULT_COUNT_CAP rows `total` is a floor and an offset pager built on it stops at the cap.
 */
export async function GET(req: Request) {
	const auth = await authorizeCli(req, "view", { type: "job" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;

	const { searchParams } = new URL(req.url);

	const mine = parseMine(searchParams.get("mine"));
	if (!mine.ok) return badRequest("mine must be true or false");

	const legacyOffset = parseOffset(searchParams.get("offset"));
	if (!legacyOffset.ok) return badRequest("offset must be a non-negative integer");

	const cursorScope: CursorScope = { orgId: actor.orgId, list: JOBS_LIST };
	const parsed = parsePageOpts(searchParams, cursorScope);
	if (!parsed.ok) return badRequest(parsed.error);
	const opts = parsed.opts;

	if (opts.after !== null && legacyOffset.offset > 0) {
		return badRequest("cursor and offset cannot be combined; use cursor");
	}

	const status = searchParams.get("status");
	const db = getServiceDb();

	// THE TENANCY BOUNDARY. These routes read through getServiceDb(), whose role bypasses RLS, so
	// this predicate is the whole of it — and it is also what a cursor is fingerprinted against, so
	// a cursor minted in another org is refused above rather than answered here.
	//
	// IT IS NOT THE `owner_all` RLS POLICY WRITTEN OUT IN DRIZZLE, and the first cut of this route
	// said it was. That policy (programmables.sql:885-889) is
	// `user_id = app.current_owner OR org_id = app.current_org`, and copying it here looked like
	// the careful choice — the console reads this table THROUGH it, so a narrower predicate should
	// make the terminal and the browser disagree, which is the defect #3672 closed.
	//
	// The copy is unsound because the two are not evaluated against the same actor. RLS runs with
	// `app.current_owner` set to the SESSION's human. This route runs through `getServiceDb()` with
	// no RLS at all, and for a service token `actor.userId` is the person who MINTED it, not the
	// caller. Same shape, different subject: the policy scopes a human to themselves, the copy
	// scoped a machine credential to somebody's entire cross-org history. A policy quoted out of
	// its enforcement context is not the same statement.
	//
	// `?mine=true` NARROWS the org scope rather than replacing it, for the same reason: it means
	// "my jobs in this org", not "my jobs anywhere". See the GET doc above.
	//
	// The two `eq()` fragments are embedded in the template rather than written out as
	// `${jobs.org_id} = ${actor.orgId}` so each parameter still binds through the column's own
	// drizzle type mapper — a raw interpolation would hand postgres-js a bare string for a `uuid`
	// column. A `sql` template is used at all because `or()` is typed `SQL | undefined` and this
	// tuple's first element may not be optional; narrowing it would need an `as`, which is banned.
	// EVERY ARM IS BOUNDED BY ORG. The first cut was
	// `(org_id = actor.orgId or user_id = actor.userId)`, quoting the `owner_all` RLS policy
	// verbatim — and that is a cross-tenant leak here, because this route reads through
	// `getServiceDb()` with NO RLS, so this predicate is the only boundary and it is evaluated
	// against a different actor than the policy is.
	//
	// `actor.userId` IS THE MINTING HUMAN for a service token: `authorizeCli` builds
	// `getActiveScope(userId, serviceOrg)`, so `orgId` is the pin and `userId` is the person who
	// created the credential. An unbounded owner arm therefore returns that person's jobs from
	// EVERY org they belong to — project names and `config_snapshot` included — through a token
	// pinned to one. A consultant in two client orgs mints a token for client A's CI and A's
	// pipeline lists client B's jobs. The pin is re-checked on every request two files over
	// precisely to stop a token acting outside its tenant; this walked past it.
	//
	// `org_id IN (orgId, userId)` is the same row set the owner arm was actually FOR. #3942 stamps
	// `org_id` forward with no backfill, so pre-#3942 runner jobs still carry `org_id = user_id` —
	// the caller's personal org, whose id IS their user id. That is the recovery this needs, and it
	// is expressible on `org_id` alone, which keeps the tenancy boundary one column wide.
	//
	// It is also why the walk can still use `idx_jobs_org_cursor`: a disjunction across two columns
	// plans a BitmapOr, which is unordered, so every page re-sorts. An `IN` on the leading index
	// column does not.
	const orgScope: SQL = inArray(jobs.org_id, [actor.orgId, actor.userId]);
	const visible: SQL = mine.mine ? sql`(${eq(jobs.user_id, actor.userId)} and ${orgScope})` : orgScope;

	const scope: [SQL, ...(SQL | undefined)[]] = [
		visible,
		status ? sql`${jobs.status}::text = ${status}` : undefined,
	];

	const { items, page } = await paginate({
		db,
		table: jobs,
		createdAt: jobs.created_at,
		id: jobs.id,
		scope,
		cursor: cursorScope,
		opts,
		rows: (query) =>
			db
				.select({
					job: jobs,
					// The ordering key as Postgres renders it — six fractional digits. Reading
					// `jobs.created_at` here would hand back a millisecond-precision JS Date and the
					// cursor built from it would silently skip every row in the truncated gap.
					cursor_key: cursorKey(jobs.created_at),
					project_name: projects.project_name,
					runner_name: runners.name,
				})
				.from(jobs)
				.leftJoin(projects, eq(jobs.project_id, projects.id))
				.leftJoin(runners, eq(jobs.runner_id, runners.id))
				.where(query.where)
				.orderBy(...query.orderBy)
				.limit(query.limit)
				.offset(legacyOffset.offset),
		positionOf: (r) => ({ createdAt: r.cursor_key, id: r.job.id }),
	});

	const result = items.map((r) => ({
		...r.job,
		project_name: r.project_name ?? null,
		runner_name: r.runner_name ?? null,
	}));

	// `total`/`limit`/`offset` are the pre-cursor wire, kept so the shipped CLI's offset pager
	// keeps working. `total` IS `page.total` and `limit` IS `page.limit` — echoed, never counted
	// or clamped a second time, because two fields that must agree are two fields that can
	// disagree.
	return cliJson(cliJobsPageResponse, {
		jobs: result,
		total: page.total,
		limit: page.limit,
		offset: legacyOffset.offset,
		page,
	});
}
