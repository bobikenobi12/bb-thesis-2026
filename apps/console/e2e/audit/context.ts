// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Turning a MANIFEST ROUTE into a URL the browser can visit.
//
// The manifest is a set of Next.js route patterns (`/[org]/[project]/jobs`). The audit visits real
// pages, so every parameter has to resolve to a real row. Two rules govern how:
//
//  1. **The empty org is the subject, and it stays empty for as long as it can.** T5 ("the empty
//     state renders through `EmptyState`") can only be answered against an org with nothing in it —
//     that is why `pnpm env:up --empty` exists. So every route that needs nothing but `[org]` is
//     audited FIRST, against the untouched org, and only then are the few rows that `[project]` and
//     `[id]` require written. `routes.spec.ts` declares the two passes in that order and the
//     `audit` project sets `fullyParallel: false`, which is what makes the order real rather than
//     hoped-for.
//  2. **A parameter is never faked.** A route visited with an id that does not exist renders a
//     not-found, and a not-found is not the page — R1/R3/R4/R5 would all be measured against the
//     wrong DOM and would report PASS for a page nobody looked at.
//
// Seeding reuses `e2e/helpers/seed.ts` and `e2e/helpers/db.ts` (owner-role SQL, RLS bypassed, every
// row carrying both user_id and org_id) rather than re-implementing either.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { db, orgIdBySlug } from "../helpers/db";
import { seedJob, seedProject, type Owner } from "../helpers/seed";
import type { RouteParam, RouteRecord } from "./manifest";

export interface AuditContext {
	orgSlug: string;
	owner: Owner;
	/** Written by `seedRouteFixtures`; absent until the empty-org pass is done. */
	projectSlug?: string;
	jobId?: string;
	supportCaseId?: string;
}

/**
 * The org the signed-in persona lands in.
 *
 * `/dashboard` is the app's own "where do I belong" redirect, so this asks the product rather than
 * reconstructing the answer from a slugified name — which is how the hero fixture once resolved
 * `accept-terms` as an org slug.
 */
export async function resolveOrgSlug(page: Page): Promise<string> {
	await page.goto("/dashboard");
	await page.waitForURL(
		(url) =>
			/^\/[^/]+$/.test(url.pathname) &&
			!/^\/(signup|onboarding|login|accept-terms|dashboard|invites|start|cli)$/.test(url.pathname),
		{ timeout: 60_000 },
	);
	const slug = new URL(page.url()).pathname.replace(/^\//, "");
	if (!slug) throw new Error(`could not resolve an org slug from ${page.url()}`);
	return slug;
}

/** The owner scope (org id + a user id in it) the seeders need, looked up from the slug. */
export async function resolveOwner(orgSlug: string): Promise<Owner> {
	const orgId = await orgIdBySlug(orgSlug);
	if (!orgId) throw new Error(`no organization row for slug "${orgSlug}" — is this the right database?`);
	// SNAKE_CASE, not the schema's camelCase keys. `lib/db/schema/organizations.ts` declares
	// `organizationId` / `userId` because that is what Better Auth's adapter expects, and the drizzle
	// instance's `casing: "snake_case"` maps them to `organization_id` / `user_id` in Postgres. Raw
	// SQL talks to the COLUMNS. (`e2e/helpers/db.ts:pendingInvitationId` still quotes the camelCase
	// names and therefore cannot run at all — flagged, but out of this unit's scope to fix.)
	const rows = await db()<{ user_id: string }[]>`
		select user_id from member
		where organization_id = ${orgId} and role in ('owner', 'admin')
		order by created_at asc limit 1`;
	const userId = rows[0]?.user_id;
	if (!userId) throw new Error(`organization ${orgId} has no owner/admin member row`);
	return { userId, orgId };
}

/**
 * Writes the MINIMUM the parameterised routes need: one project (with its environment), one job,
 * one support case. Nothing else — every extra row is a page that can no longer answer T5.
 */
export async function seedRouteFixtures(ctx: AuditContext): Promise<void> {
	const project = await seedProject(ctx.owner, { name: `Audit ${Date.now()}` });
	const job = await seedJob(ctx.owner, { projectId: project.projectId, envId: project.envId });
	const sql = db();
	const [supportCase] = await sql<{ id: string }[]>`
		insert into support_cases ${sql({
			user_id: ctx.owner.userId,
			org_id: ctx.owner.orgId,
			type: "technical",
			category: "other",
			severity: "normal",
			status: "open",
			subject: "UI audit fixture case",
			context: sql.json({}),
			contact: sql.json({ email: "audit@alethia.test" }),
		})}
		returning id`;
	await sql`
		insert into support_messages ${sql({
			case_id: supportCase.id,
			author_type: "customer",
			author_id: ctx.owner.userId,
			body: "Opened by the console UI audit so the case detail route has a page to render.",
		})}`;
	ctx.projectSlug = project.slug;
	ctx.jobId = job.id;
	ctx.supportCaseId = supportCase.id;
}

/**
 * Where the seeded ids are kept so a WORKER RESTART cannot lose them.
 *
 * Measured (2026-09-01): a single test timing out makes Playwright discard the worker and start the
 * next test in a fresh one. `beforeAll` runs again there, but the seeding STEP does not — it has
 * already reported — so `ctx.projectSlug` came back undefined and every `[project]` route in pass 2
 * raised "cannot materialise". The ids live in a file for that reason, and the file is keyed on the
 * org slug so a leftover from a PREVIOUS run (a different org, different rows) can never be picked
 * up as this run's fixture.
 */
const CONTEXT_FILE = path.resolve(process.cwd(), "e2e/.auth/audit-context.json");

/** Persist the seeded ids for whichever worker runs next. */
export function saveContext(ctx: AuditContext): void {
	mkdirSync(path.dirname(CONTEXT_FILE), { recursive: true });
	writeFileSync(
		CONTEXT_FILE,
		`${JSON.stringify(
			{ orgSlug: ctx.orgSlug, projectSlug: ctx.projectSlug, jobId: ctx.jobId, supportCaseId: ctx.supportCaseId },
			null,
			2,
		)}\n`,
	);
}

/** Restore the seeded ids IF they belong to this run's org. Silent when there is nothing to restore. */
export function restoreContext(ctx: AuditContext): void {
	if (!existsSync(CONTEXT_FILE)) return;
	const saved: unknown = JSON.parse(readFileSync(CONTEXT_FILE, "utf8"));
	if (typeof saved !== "object" || saved === null) return;
	if (!("orgSlug" in saved) || saved.orgSlug !== ctx.orgSlug) return;
	if ("projectSlug" in saved && typeof saved.projectSlug === "string") ctx.projectSlug = saved.projectSlug;
	if ("jobId" in saved && typeof saved.jobId === "string") ctx.jobId = saved.jobId;
	if ("supportCaseId" in saved && typeof saved.supportCaseId === "string") ctx.supportCaseId = saved.supportCaseId;
}

/**
 * Parameters this audit knows how to resolve.
 *
 * Takes the whole `RouteParam`, not just its name: the zero-segment form is legal for the OPTIONAL
 * catch-all `[[...rest]]` and for nothing else. Keyed on the name alone, a REQUIRED `[...rest]`
 * resolved to "" too — and Next answers that with a not-found, which is exactly the outcome this
 * module's header says must never happen, made worse by being silent where every other unresolvable
 * parameter raises.
 */
function valueFor(param: RouteParam, route: string, ctx: AuditContext): string | null {
	if (param.name === "org") return ctx.orgSlug;
	if (param.name === "project") return ctx.projectSlug ?? null;
	if (param.catchAll && param.optional) return "";
	if (param.name === "id") {
		if (route.startsWith("/[org]/~/jobs/")) return ctx.jobId ?? null;
		if (route.startsWith("/[org]/~/support/cases/")) return ctx.supportCaseId ?? null;
		return null;
	}
	return null;
}

/** True when the route needs nothing but `[org]` — the pass that runs against the untouched org. */
export function needsOnlyOrg(route: RouteRecord): boolean {
	return route.params.every((p) => p.name === "org" || (p.optional && p.catchAll));
}

/**
 * The concrete path for a route, or a raise naming the parameter that could not be resolved.
 *
 * It RAISES rather than returning null: a route the audit quietly declined to visit and a route
 * that scored zero are the same thing in a report, and this whole wave exists because that
 * ambiguity is unacceptable.
 */
export function materialize(route: RouteRecord, ctx: AuditContext): string {
	let path = route.route;
	for (const p of route.params) {
		const value = valueFor(p, route.route, ctx);
		if (value === null) {
			throw new Error(
				`cannot materialise ${route.route}: no value for "${p.segment}". Every manifest route ` +
					`must be visitable — teach e2e/audit/context.ts how to resolve it (and seed whatever ` +
					`row it needs) rather than skipping the route.`,
			);
		}
		path = path.replace(p.segment, value);
	}
	// The optional catch-all contributes an empty segment; collapse the `//` it leaves behind.
	return path.replace(/\/{2,}/g, "/").replace(/(.)\/$/, "$1");
}
