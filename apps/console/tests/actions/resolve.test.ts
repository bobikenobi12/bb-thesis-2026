// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for the C2 slug-resolution actions: stub getOwnerScope + currentActor +
// a thenable drizzle chain (getServiceDb for org reads, withActorScope for tenant-scoped reads)
// and the workspace setActiveOrganization side-effect, then assert the personal-scope branch, the
// membership/404 throws, the active-org sync, and the returned shapes.
//
// currentActor MUST be mocked directly: the org-shared slug resolvers (resolveProjectId /
// getProjectSlug / getEnvironmentsForSlug) call it, and its real getActiveScope() hits the ee
// resolver — `core.db.execute(<member lookup>)` — under the enterprise build (CI). With @/lib/db
// mocked (no `execute`), the real path throws "core.db.execute is not a function"; the community
// build accidentally hides it (getActiveScope is DB-free there). So stub currentActor at the seam.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/owner", () => ({ getOwnerScope: vi.fn() }));
vi.mock("@/lib/authz/guard", () => ({ currentActor: vi.fn() }));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn(), withActorScope: vi.fn() }));
vi.mock("@/app/server/actions/workspace", () => ({
	setActiveOrganization: vi.fn(),
}));

import {
	getActiveOrgSlug,
	getEnvironmentsForSlug,
	getProjectSlug,
	resolveOrgScope,
	resolveProjectId,
} from "@/app/server/actions/resolve";
import { getOwnerScope } from "@/lib/auth/owner";
import { currentActor } from "@/lib/authz/guard";
import { getServiceDb, withActorScope } from "@/lib/db";
import { setActiveOrganization } from "@/app/server/actions/workspace";

/**
 * A drizzle-ish chain whose every builder returns itself and which awaits to the next queued
 * result. `.limit()` / `.orderBy()` are terminal, so we pop one seeded result per terminal await.
 */
function makeChain(results: unknown[][]) {
	const queue = [...results];
	const chain: Record<string, unknown> = {};
	const passthrough = () => chain;
	Object.assign(chain, {
		select: passthrough,
		from: passthrough,
		innerJoin: passthrough,
		leftJoin: passthrough,
		where: passthrough,
		limit: passthrough,
		orderBy: passthrough,
		then: (resolve: (v: unknown) => void) => resolve(queue.shift() ?? []),
	});
	return chain;
}

/** Stub getServiceDb with a chain seeded with the given terminal results (in await order). */
function mockServiceDb(...results: unknown[][]) {
	vi.mocked(getServiceDb).mockReturnValue(makeChain(results) as never);
}

/** Stub withActorScope so it invokes its callback with a tx chain seeded with results. */
function mockActorScope(...results: unknown[][]) {
	vi.mocked(withActorScope).mockImplementation(
		(async (_actor: { userId: string; orgId: string }, cb: (tx: unknown) => unknown) =>
			cb(makeChain(results))) as never,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(getOwnerScope).mockResolvedValue({
		userId: "user-1",
		activeOrgId: "user-1",
	} as never);
	// The slug resolvers scope by currentActor(); stub it directly (its real getActiveScope hits
	// the ee `core.db.execute` member lookup under the enterprise build — see the file header).
	vi.mocked(currentActor).mockResolvedValue({
		userId: "user-1",
		orgId: "user-1",
	} as never);
});

describe("resolveOrgScope", () => {
	it("returns the personal scope for `~` without touching the org table", async () => {
		const r = await resolveOrgScope("~");
		expect(r).toEqual({ orgId: "user-1", isPersonal: true });
		expect(getServiceDb).not.toHaveBeenCalled();
		// activeOrgId already === userId → no clearing needed.
		expect(setActiveOrganization).not.toHaveBeenCalled();
	});

	it("clears a stale active org when switching to personal", async () => {
		vi.mocked(getOwnerScope).mockResolvedValue({
			userId: "user-1",
			activeOrgId: "org-9",
		} as never);
		const r = await resolveOrgScope("~");
		expect(r).toEqual({ orgId: "user-1", isPersonal: true });
		expect(setActiveOrganization).toHaveBeenCalledWith("user-1");
	});

	it("resolves a real slug for a member and syncs the active org", async () => {
		mockServiceDb([{ id: "org-1" }]);
		const r = await resolveOrgScope("acme");
		expect(r).toEqual({ orgId: "org-1", isPersonal: false });
		// activeOrgId was "user-1" ≠ org-1 → sync.
		expect(setActiveOrganization).toHaveBeenCalledWith("org-1");
	});

	it("does not re-sync when the slug already matches the active org", async () => {
		vi.mocked(getOwnerScope).mockResolvedValue({
			userId: "user-1",
			activeOrgId: "org-1",
		} as never);
		mockServiceDb([{ id: "org-1" }]);
		const r = await resolveOrgScope("acme");
		expect(r).toEqual({ orgId: "org-1", isPersonal: false });
		expect(setActiveOrganization).not.toHaveBeenCalled();
	});

	it("calls notFound() when the slug doesn't resolve to a member org", async () => {
		mockServiceDb([]); // no org/membership row
		await expect(resolveOrgScope("ghost")).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK/);
		expect(setActiveOrganization).not.toHaveBeenCalled();
	});

	// #4089. `[org]/layout.tsx` calls this on every render of every `/{org}/…` route, so every
	// one of those renders — INCLUDING the ones Next issues speculatively when it prefetches a
	// link in the viewport — can move the session's tenant. The three cases above each cover one
	// branch; this one states the property they add up to, in one place, so that a future reader
	// weighing "is a wrong href really a security problem?" does not have to reassemble it: BOTH
	// branches write, and a request the user never made is enough to trigger either.
	//
	// This cannot assert "a prefetch does not write". The distinguishing header is invisible to
	// application code in Next 16.3.3 (`next-router-prefetch` is a FLIGHT_HEADER, sealed out of
	// `headers()` and deleted before `proxy.ts` runs), so no gate can be written here and no test
	// can drive one. What holds the defect shut is one layer up: every prefetchable href names
	// the org the address bar already names, so a speculative resolve re-asserts the org the user
	// is already in. `tests/hooks/use-active-org-slug.test.tsx` is that half. This test is why
	// that half matters — delete the guarantee there and these writes fire on a phantom GET.
	it("writes the session's active org on BOTH branches — a GET here is a tenant mutation", async () => {
		// Real-slug branch: the URL's org is written into the session.
		vi.mocked(getOwnerScope).mockResolvedValue({
			userId: "user-1",
			activeOrgId: "user-1",
		} as never);
		mockServiceDb([{ id: "org-1" }]);
		await resolveOrgScope("acme");
		expect(setActiveOrganization).toHaveBeenCalledWith("org-1");

		// `~` branch: an org that WAS active is cleared back to the personal scope. Patching only
		// the branch named in the bug report would leave this one standing.
		vi.mocked(setActiveOrganization).mockClear();
		vi.mocked(getOwnerScope).mockResolvedValue({
			userId: "user-1",
			activeOrgId: "org-1",
		} as never);
		await resolveOrgScope("~");
		expect(setActiveOrganization).toHaveBeenCalledWith("user-1");
	});
});

describe("resolveProjectId", () => {
	it("returns the project id for a resolvable slug", async () => {
		mockActorScope([{ id: "proj-1" }]);
		await expect(resolveProjectId("api")).resolves.toBe("proj-1");
		expect(withActorScope).toHaveBeenCalledWith(
			expect.objectContaining({ userId: "user-1", orgId: "user-1" }),
			expect.any(Function),
		);
	});

	it("calls notFound() when the project slug doesn't resolve", async () => {
		mockActorScope([]);
		await expect(resolveProjectId("nope")).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK/);
	});
});

describe("getActiveOrgSlug", () => {
	it("returns the slug of the explicitly selected active org", async () => {
		vi.mocked(getOwnerScope).mockResolvedValue({
			userId: "user-1",
			activeOrgId: "org-1",
		} as never);
		mockServiceDb([{ slug: "acme" }]);
		await expect(getActiveOrgSlug()).resolves.toBe("acme");
	});

	it("falls back to the earliest membership when no org is selected", async () => {
		// activeOrgId === userId (personal) → skips the first lookup, uses primary query.
		mockServiceDb([{ slug: "primary-org" }]);
		await expect(getActiveOrgSlug()).resolves.toBe("primary-org");
	});

	it("falls back to the primary membership when the selected org row is missing", async () => {
		vi.mocked(getOwnerScope).mockResolvedValue({
			userId: "user-1",
			activeOrgId: "org-gone",
		} as never);
		// First lookup (by activeOrgId) returns nothing → second (primary) returns a row.
		mockServiceDb([], [{ slug: "primary-org" }]);
		await expect(getActiveOrgSlug()).resolves.toBe("primary-org");
	});

	it("returns the personal slug when the user has no memberships", async () => {
		mockServiceDb([]); // no primary membership
		await expect(getActiveOrgSlug()).resolves.toBe("~");
	});
});

describe("getProjectSlug", () => {
	it("returns the slug for a known project id", async () => {
		mockActorScope([{ projectSlug: "api" }]);
		await expect(getProjectSlug("proj-1")).resolves.toBe("api");
	});

	it("returns null when the project id isn't in scope", async () => {
		mockActorScope([]);
		await expect(getProjectSlug("proj-x")).resolves.toBeNull();
	});
});

describe("getEnvironmentsForSlug", () => {
	it("returns [] when the project slug doesn't resolve", async () => {
		mockActorScope([]); // project lookup empty
		await expect(getEnvironmentsForSlug("nope")).resolves.toEqual([]);
	});

	it("lists the project's environments when the slug resolves", async () => {
		const envs = [
			{ id: "env-1", name: "staging", stage: "staging", is_default: true },
			{ id: "env-2", name: "prod", stage: "production", is_default: false },
		];
		// First terminal await = project lookup; second = env list.
		mockActorScope([{ id: "proj-1" }], envs);
		await expect(getEnvironmentsForSlug("api")).resolves.toEqual(envs);
	});
});
