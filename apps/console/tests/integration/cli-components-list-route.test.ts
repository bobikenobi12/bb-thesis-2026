// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: GET /api/cli/projects/:id/components — a deterministic cursor over fourteen
// physical component tables. The database is real because the contract depends on three SQL
// properties mocks cannot prove: each table is project/environment scoped, equal timestamps use
// the UUID tiebreak, and a capped aggregate count stops across the heterogeneous collection.

import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { z } from "zod";
import { describeIfDb } from "./db";

vi.mock("@/lib/authz/guard", () => ({
	authorizeCli: vi.fn(),
	ensureCliOrgAccess: vi.fn(),
}));

import { GET } from "@/app/api/cli/projects/[id]/components/route";
import { authorizeCli } from "@/lib/authz/guard";
import {
	DEFAULT_COUNT_CAP,
	MAX_PAGE_SIZE,
	type PageInfo,
} from "@/lib/cli/paging";
import { getServiceDb } from "@/lib/db";
import {
	projectCaches,
	projectDatabases,
	projectEnvironments,
	projectNetwork,
	projects,
} from "@/lib/db/schema";

const ORG_A = randomUUID();
const ORG_B = randomUUID();
const USER_A = randomUUID();
const USER_B = randomUUID();
const PROJECT_A = randomUUID();
const PROJECT_B = randomUUID();
const PROJECT_CAPPED = randomUUID();
const ENV_A_PROD = randomUUID();
const ENV_A_STAGING = randomUUID();
const ENV_B = randomUUID();
const ENV_CAPPED = randomUUID();

const NETWORK_A = randomUUID();
const DATABASE_A_NEW = randomUUID();
const DATABASE_A_TIE_LOW = "10000000-0000-4000-8000-000000000001";
const DATABASE_A_TIE_HIGH = "f0000000-0000-4000-8000-000000000001";
const DATABASE_A_OLD = randomUUID();
const DATABASE_A_STAGING = randomUUID();
const CACHE_A_NEW = randomUUID();
const CACHE_A_OLD = randomUUID();

const pageSchema = z.object({
	mode: z.enum(["exact", "capped"]),
	limit: z.number().int().positive(),
	total: z.number().int().nonnegative(),
	next_cursor: z.string().nullable(),
});
const bodySchema = z.object({
	components: z.array(
		z.object({
			id: z.string(),
			kind: z.string(),
			name: z.string(),
			status: z.string(),
			cloud_identity_id: z.string().nullable(),
			config: z.record(z.string(), z.unknown()),
		}),
	),
	page: pageSchema,
});
type Body = z.infer<typeof bodySchema>;

/** Points the stubbed PDP guard at one tenant for the next request. */
function actingAs(userId: string, orgId: string): void {
	vi.mocked(authorizeCli).mockResolvedValue({ actor: { userId, orgId } });
}

/** Calls the route and returns its status plus unparsed JSON body. */
async function request(projectId: string, query = "") {
	const response = await GET(
		new Request(
			`http://console.test/api/cli/projects/${projectId}/components${query}`,
		),
		{ params: Promise.resolve({ id: projectId }) },
	);
	return { status: response.status, body: await response.json() };
}

/** Calls a successful page and validates the complete wire envelope. */
async function get(projectId: string, query = ""): Promise<Body> {
	const result = await request(projectId, query);
	if (result.status !== 200) {
		throw new Error(
			`expected 200, got ${result.status}: ${JSON.stringify(result.body)}`,
		);
	}
	return bodySchema.parse(result.body);
}

/** Walks one filtered collection to cursor exhaustion with a hard loop bound. */
async function walk(projectId: string, filter = "") {
	const components: Body["components"] = [];
	const pages: PageInfo[] = [];
	let cursor = "";
	for (let page = 0; page < 30; page++) {
		const baseQuery = filter || "?limit=2";
		const body = await get(
			projectId,
			`${baseQuery}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
		);
		components.push(...body.components);
		pages.push(body.page);
		if (body.page.next_cursor === null) return { components, pages };
		cursor = body.page.next_cursor;
	}
	throw new Error("component cursor did not exhaust in 30 pages");
}

describeIfDb(
	"GET project components — heterogeneous cursor paging (#4201)",
	() => {
		beforeAll(async () => {
			const db = getServiceDb();
			await db.insert(projects).values([
				{
					id: PROJECT_A,
					org_id: ORG_A,
					user_id: USER_A,
					project_name: `components-a-${PROJECT_A}`,
					slug: `components-a-${PROJECT_A}`,
					region: "eu-west-1",
					iac_version: "1.0.0",
				},
				{
					id: PROJECT_B,
					org_id: ORG_B,
					user_id: USER_B,
					project_name: `components-b-${PROJECT_B}`,
					slug: `components-b-${PROJECT_B}`,
					region: "eu-west-1",
					iac_version: "1.0.0",
				},
				{
					id: PROJECT_CAPPED,
					org_id: ORG_A,
					user_id: USER_A,
					project_name: `components-cap-${PROJECT_CAPPED}`,
					slug: `components-cap-${PROJECT_CAPPED}`,
					region: "eu-west-1",
					iac_version: "1.0.0",
				},
			]);
			await db.insert(projectEnvironments).values([
				{
					id: ENV_A_PROD,
					project_id: PROJECT_A,
					org_id: ORG_A,
					user_id: USER_A,
					name: "production",
					is_default: true,
				},
				{
					id: ENV_A_STAGING,
					project_id: PROJECT_A,
					org_id: ORG_A,
					user_id: USER_A,
					name: "staging",
					is_default: false,
				},
				{
					id: ENV_B,
					project_id: PROJECT_B,
					org_id: ORG_B,
					user_id: USER_B,
					name: "production",
					is_default: true,
				},
				{
					id: ENV_CAPPED,
					project_id: PROJECT_CAPPED,
					org_id: ORG_A,
					user_id: USER_A,
					name: "production",
					is_default: true,
				},
			]);

			await db.insert(projectNetwork).values({
				id: NETWORK_A,
				project_id: PROJECT_A,
				environment_id: ENV_A_PROD,
				created_at: new Date("2025-01-01T00:00:00.000Z"),
			});
			await db.insert(projectDatabases).values([
				{
					id: DATABASE_A_NEW,
					project_id: PROJECT_A,
					environment_id: ENV_A_PROD,
					name: "new",
					created_at: new Date("2025-05-01T00:00:00.000Z"),
				},
				{
					id: DATABASE_A_TIE_LOW,
					project_id: PROJECT_A,
					environment_id: ENV_A_PROD,
					name: "tie-low",
					created_at: new Date("2025-04-01T00:00:00.000Z"),
				},
				{
					id: DATABASE_A_TIE_HIGH,
					project_id: PROJECT_A,
					environment_id: ENV_A_PROD,
					name: "tie-high",
					created_at: new Date("2025-04-01T00:00:00.000Z"),
				},
				{
					id: DATABASE_A_OLD,
					project_id: PROJECT_A,
					environment_id: ENV_A_PROD,
					name: "old",
					created_at: new Date("2025-03-01T00:00:00.000Z"),
				},
				{
					id: DATABASE_A_STAGING,
					project_id: PROJECT_A,
					environment_id: ENV_A_STAGING,
					name: "staging",
					created_at: new Date("2025-06-01T00:00:00.000Z"),
				},
			]);
			await db.insert(projectCaches).values([
				{
					id: CACHE_A_NEW,
					project_id: PROJECT_A,
					environment_id: ENV_A_PROD,
					name: "cache-new",
					created_at: new Date("2026-01-01T00:00:00.000Z"),
				},
				{
					id: CACHE_A_OLD,
					project_id: PROJECT_A,
					environment_id: ENV_A_PROD,
					name: "cache-old",
					created_at: new Date("2024-01-01T00:00:00.000Z"),
				},
			]);
			await db.insert(projectDatabases).values(
				Array.from({ length: 4 }, (_, index) => ({
					project_id: PROJECT_B,
					environment_id: ENV_B,
					name: `tenant-b-${index}`,
				})),
			);
			await db.insert(projectDatabases).values(
				Array.from({ length: DEFAULT_COUNT_CAP }, (_, index) => ({
					project_id: PROJECT_CAPPED,
					environment_id: ENV_CAPPED,
					name: `capped-${index}`,
				})),
			);
		});

		afterAll(async () => {
			await getServiceDb()
				.delete(projects)
				.where(inArray(projects.id, [PROJECT_A, PROJECT_B, PROJECT_CAPPED]));
		});

		it("walks registry order then immutable created_at/id order without gaps or duplicates", async () => {
			actingAs(USER_A, ORG_A);
			const { components, pages } = await walk(PROJECT_A);
			expect(components.map((component) => component.id)).toEqual([
				NETWORK_A,
				DATABASE_A_STAGING,
				DATABASE_A_NEW,
				DATABASE_A_TIE_HIGH,
				DATABASE_A_TIE_LOW,
				DATABASE_A_OLD,
				CACHE_A_NEW,
				CACHE_A_OLD,
			]);
			expect(new Set(components.map((component) => component.id)).size).toBe(
				components.length,
			);
			expect(pages).toHaveLength(4);
			expect(
				pages.slice(0, -1).every((page) => page.next_cursor !== null),
			).toBe(true);
			expect(pages[pages.length - 1]?.next_cursor).toBeNull();
			expect(pages.every((page) => page.total === components.length)).toBe(
				true,
			);
		});

		it("crosses a registry-kind boundary with a one-row page", async () => {
			actingAs(USER_A, ORG_A);
			const first = await get(PROJECT_A, "?limit=1");
			expect(first.components.map((component) => component.id)).toEqual([
				NETWORK_A,
			]);
			const second = await get(
				PROJECT_A,
				`?limit=1&cursor=${encodeURIComponent(first.page.next_cursor ?? "")}`,
			);
			expect(second.components.map((component) => component.id)).toEqual([
				DATABASE_A_STAGING,
			]);
		});

		it("keeps both filters across pages and lets equal timestamps straddle a boundary", async () => {
			actingAs(USER_A, ORG_A);
			const { components } = await walk(
				PROJECT_A,
				"?kind=databases&env=production&limit=2",
			);
			expect(components.map((component) => component.id)).toEqual([
				DATABASE_A_NEW,
				DATABASE_A_TIE_HIGH,
				DATABASE_A_TIE_LOW,
				DATABASE_A_OLD,
			]);
		});

		it("filters independently by kind and environment", async () => {
			actingAs(USER_A, ORG_A);
			const databases = await get(PROJECT_A, "?kind=databases&limit=20");
			expect(databases.components).toHaveLength(5);
			expect(
				databases.components.every(
					(component) => component.kind === "databases",
				),
			).toBe(true);

			const production = await get(PROJECT_A, "?env=production&limit=20");
			expect(
				production.components.map((component) => component.id),
			).not.toContain(DATABASE_A_STAGING);
			expect(production.page.total).toBe(7);
		});

		it("serves the compatibility first page at the maximum bounded size", async () => {
			actingAs(USER_A, ORG_A);
			const body = await get(PROJECT_A);
			expect(body.page.limit).toBe(MAX_PAGE_SIZE);
			expect(body.components).toHaveLength(8);
			expect(body.page.next_cursor).toBeNull();
		});

		it("distinguishes an exact aggregate at the cap from cap plus one", async () => {
			actingAs(USER_A, ORG_A);
			const exact = await get(
				PROJECT_CAPPED,
				"?kind=databases&limit=999999",
			);
			expect(exact.components).toHaveLength(MAX_PAGE_SIZE);
			expect(exact.page).toMatchObject({
				mode: "exact",
				limit: MAX_PAGE_SIZE,
				total: DEFAULT_COUNT_CAP,
			});
			expect(exact.page.next_cursor).not.toBeNull();

			await getServiceDb().insert(projectDatabases).values({
				project_id: PROJECT_CAPPED,
				environment_id: ENV_CAPPED,
				name: "over-the-cap",
			});
			const capped = await get(PROJECT_CAPPED, "?kind=databases&limit=1");
			expect(capped.page).toMatchObject({
				mode: "capped",
				limit: 1,
				total: DEFAULT_COUNT_CAP,
			});
			expect(capped.page.next_cursor).not.toBeNull();
		});

		it("refuses malformed and project/filter/tenant-foreign cursors", async () => {
			actingAs(USER_A, ORG_A);
			const malformed = await request(PROJECT_A, "?cursor=not-a-cursor");
			expect(malformed.status).toBe(400);
			expect(malformed.body).toMatchObject({ error: "cursor is malformed" });

			const first = await get(PROJECT_A, "?limit=1");
			const cursor = encodeURIComponent(first.page.next_cursor ?? "");
			const changedKind = await request(
				PROJECT_A,
				`?kind=databases&cursor=${cursor}`,
			);
			expect(changedKind.status).toBe(400);
			const changedEnvironment = await request(
				PROJECT_A,
				`?env=production&cursor=${cursor}`,
			);
			expect(changedEnvironment.status).toBe(400);
			const changedProject = await request(
				PROJECT_CAPPED,
				`?cursor=${cursor}`,
			);
			expect(changedProject.status).toBe(400);

			actingAs(USER_B, ORG_B);
			const foreign = await request(PROJECT_B, `?cursor=${cursor}`);
			expect(foreign.status).toBe(400);
		});

		it("never resolves or lists another tenant's project", async () => {
			actingAs(USER_B, ORG_B);
			const denied = await request(PROJECT_A, "?limit=20");
			expect(denied.status).toBe(404);
			expect(denied.body).toMatchObject({ error: "Project not found" });

			const own = await get(PROJECT_B, "?limit=20");
			expect(own.components).toHaveLength(4);
			expect(
				own.components.every((component) =>
					component.name.startsWith("tenant-b-"),
				),
			).toBe(true);
		});
	},
);
