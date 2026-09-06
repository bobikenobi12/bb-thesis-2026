// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #4133 — the tenant comes from the ADDRESS, and a session pointing somewhere else cannot move it.
//
// Before this, `currentActor()` read `session.active_organization_id` and nothing else, so a
// session on org A serving a request addressed to org B rendered A's rows under B's slug: no
// error, no clue, a 200. These tests drive exactly that disagreement — the session says A, the
// header the proxy publishes says B — and assert which id reaches `getActiveScope`, because that
// id is what every reader below is scoped by.
//
// They also pin the two things that are NOT a fallback, because both would restore the defect
// quietly: an address naming an org the caller is not in must THROW rather than answer with the
// caller's own tenant, and the MCP token path (which has no address at all) must not acquire one.

import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG_A = "org-aaaaaaaa-0000-0000-0000-000000000001";
const ORG_B = "org-bbbbbbbb-0000-0000-0000-000000000002";
const USER = "user-00000000-0000-0000-0000-000000000009";

/** The row `urlScopedOrgId`'s membership join returns, or [] for "not a member". */
let orgRow: Array<{ id: string }> = [];
/** The path the proxy published for this request; null = the proxy set no header. */
let requestPath: string | null = null;

vi.mock("next/headers", () => ({
	headers: vi.fn(async () => {
		const h = new Headers();
		if (requestPath !== null) h.set("x-alethia-path", requestPath);
		return h;
	}),
}));
vi.mock("@/lib/db", () => ({
	getServiceDb: () => ({
		select: () => ({
			from: () => ({
				innerJoin: () => ({ where: () => ({ limit: async () => orgRow }) }),
			}),
		}),
	}),
}));
vi.mock("@/lib/auth/owner", () => ({
	// The session is on org A for every case below. That is the point: it never wins.
	getOwnerScope: vi.fn(async () => ({
		userId: USER,
		sessionId: "s1",
		activeOrgId: ORG_A,
	})),
}));
/**
 * WHICH EDITION'S SCOPE RESOLVER IS ANSWERING. This is not decoration — it is the axis the first
 * version of this suite got wrong, and the reason a defect that would have 500'd every `/{org}/…`
 * page in the AGPL build passed every test.
 *
 *  · `enterprise` honours its org argument (ee/src/scope.ts validates the `member` row).
 *  · `community` IGNORES it and always answers the personal scope — `lib/auth/scope.ts` takes the
 *    `: { userId, orgId: userId }` branch whenever `getEnterprise()` is null, while community still
 *    provisions real organizations with real slugs and real `member` rows.
 *
 * Mocking only the first is mocking the assumption under test.
 */
let edition: "enterprise" | "community" = "enterprise";
vi.mock("@/lib/auth/scope", () => ({
	getActiveScope: vi.fn(async (userId: string, orgId?: string) => ({ userId, orgId: orgId ?? userId })),
}));

import { currentActor } from "@/lib/authz/guard";
import { getActiveScope } from "@/lib/auth/scope";
import { runWithActor } from "@/lib/authz/actor-context";
import { ForbiddenError } from "@/lib/authz/types";

/** The org id `currentActor()` handed to the scope resolver — what every reader is scoped by. */
const scopedWith = () => vi.mocked(getActiveScope).mock.calls.at(-1)?.[1];

beforeEach(() => {
	vi.mocked(getActiveScope).mockReset();
	vi.mocked(getActiveScope).mockImplementation(async (userId: string, orgId?: string) =>
		edition === "community"
			? { userId, orgId: userId }
			: { userId, orgId: orgId ?? userId },
	);
	edition = "enterprise";
	orgRow = [];
	requestPath = null;
});

describe("the address decides the tenant", () => {
	it("a session on A serving B's address is scoped to B, not A", async () => {
		requestPath = "/acme/hero-app/environments";
		orgRow = [{ id: ORG_B }];
		const actor = await currentActor();
		expect(scopedWith()).toBe(ORG_B);
		expect(actor.orgId).toBe(ORG_B);
	});

	it("...and the personal segment is the personal scope, never the session's org", async () => {
		requestPath = "/~/evidence";
		const actor = await currentActor();
		expect(scopedWith()).toBe(USER);
		expect(actor.orgId).toBe(USER);
	});

	// The prefetch burst in #4089 was 36 requests to `/~/~/…`. Under the old code each one WROTE the
	// session to personal and every later request inherited it. Here the personal scope applies to
	// the request that asked for it and to nothing else — there is no state to leak forward.
	it("...and a personal-scoped request leaves the next request on its own address", async () => {
		requestPath = "/~/~/clusters";
		await currentActor();
		expect(scopedWith()).toBe(USER);
		requestPath = "/acme/hero-app/environments";
		orgRow = [{ id: ORG_B }];
		await currentActor();
		expect(scopedWith()).toBe(ORG_B);
	});
});

describe("where the session is still the answer", () => {
	it("an address with no org segment falls back to the session", async () => {
		requestPath = "/dashboard";
		await currentActor();
		expect(scopedWith()).toBe(ORG_A);
	});

	it("...and a reserved first segment is not an org slug", async () => {
		requestPath = "/cli/login";
		await currentActor();
		expect(scopedWith()).toBe(ORG_A);
	});

	// No header at all — no request scope, or a path the proxy did not reach. This is today's
	// behaviour, and it is a FALLBACK rather than a guarantee, which is why it is not the whole
	// story: `tests/lib/proxy-org-path.test.ts` asserts the proxy publishes the path on every
	// branch that reaches app code, so this arm is unreachable from the private tree.
	it("...and no published path falls back to the session rather than throwing", async () => {
		requestPath = null;
		await currentActor();
		expect(scopedWith()).toBe(ORG_A);
	});

	it("...and an injected actor (the MCP token path) is untouched — it has no address", async () => {
		requestPath = "/acme/hero-app/environments";
		orgRow = [{ id: ORG_B }];
		const injected = { userId: USER, orgId: ORG_A };
		const actor = await runWithActor(injected, () => currentActor());
		expect(actor).toBe(injected);
		expect(getActiveScope).not.toHaveBeenCalled();
	});
});

describe("what is a refusal, and is not a fallback", () => {
	// #3863, arriving by a second route. `getActiveScope` treats its org argument as a PREFERENCE
	// and, on a miss, falls back to an org the user DOES belong to — deliberately, so a stale
	// session cannot lock anyone out of the console. Following that substitution for an address is
	// how a request for B gets served from some third org C. `resolveNamedOrgScope` is the existing
	// guard for exactly this, and the URL segment now goes through it.
	// The whole defect in one assertion. Answering a request addressed to someone else's org with
	// the caller's own tenant is a wrong answer wearing a 200, and it is what falling back here
	// would produce. The message is ANCHORED: `ForbiddenError` renders as `Forbidden: view on org
	// (…)`, and pinning the start is what stops this ever reading as an authentication failure —
	// `[org]/layout.tsx` bounces the bare word "Unauthorized" to sign-in.
	it("an address naming an org the caller is not in 404s, and never yields the session's org", async () => {
		requestPath = "/not-my-org/evidence";
		orgRow = [];
		// `notFound()`, not a `ForbiddenError`. The refusal was always right; the LANDING was the
		// defect. The layout catches only around its own resolver call and Next renders layout and
		// page concurrently, so a reader's `ForbiddenError` escaped the layout entirely and every
		// stale link, shared URL and crawler hit answered 500 where `resolve.ts` promises a 404.
		// 404 also refuses to confirm the slug exists, so org names cannot be enumerated by status.
		await expect(currentActor()).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK/);
		// The part that must NOT change: no substitution was attempted on the way out.
		expect(getActiveScope).not.toHaveBeenCalled();
	});

	it("a scope resolver that SUBSTITUTES another org is refused, not followed", async () => {
		requestPath = "/acme/hero-app/environments";
		orgRow = [{ id: ORG_B }];
		const ORG_C = "org-cccccccc-0000-0000-0000-000000000003";
		vi.mocked(getActiveScope).mockResolvedValueOnce({ userId: USER, orgId: ORG_C });
		await expect(currentActor()).rejects.toThrow(/landed on a different organization/);
	});

	// THE TWO REFUSALS LAND DIFFERENTLY, ON PURPOSE, and that is the point of this case.
	//
	// Not-a-member is a fact about the ADDRESS — the same fact as an org that does not exist — so it
	// answers 404 and reveals nothing about which slugs are real. A resolver that SUBSTITUTES is a
	// fact about the SYSTEM: the caller may well belong here, and something answered with the wrong
	// tenant. That stays a `ForbiddenError` so `authorize`'s callers can classify it to a 403, and it
	// must never render as a 404, which would read as "no such page" for a genuine internal fault.
	//
	// Neither is a bare `Error`: `[org]/layout.tsx` matches the bare string "Unauthorized" exactly to
	// bounce to sign-in, which a valid session with a wrong address must not do.
	it("...and the two refusals land differently: 404 for the address, ForbiddenError for a substitution", async () => {
		requestPath = "/not-my-org/evidence";
		orgRow = [];
		await expect(currentActor()).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK/);
		requestPath = "/acme/x";
		orgRow = [{ id: ORG_B }];
		vi.mocked(getActiveScope).mockResolvedValueOnce({ userId: USER, orgId: "org-c" });
		await expect(currentActor()).rejects.toBeInstanceOf(ForbiddenError);
	});
});

// THE ARM WHOSE ABSENCE WOULD HAVE TAKEN THE WHOLE OPEN-CORE BUILD DOWN. Community's resolver
// ignores its org argument and always answers the personal scope, so in that edition EVERY org slug
// resolves to `orgId === userId`. Read as a substitution, that is a refusal on every `/{org}/…`
// page in the AGPL build; read correctly, it is what "single tenant" means. The membership join has
// already proved the caller belongs to the named org — community just has one tenant to put them in.
describe("the single-tenant edition is not a substitution", () => {
	beforeEach(() => {
		edition = "community";
	});

	it("community resolves a real org slug to the personal scope instead of refusing", async () => {
		requestPath = "/acme/hero-app/environments";
		orgRow = [{ id: ORG_B }];
		const actor = await currentActor();
		expect(actor.orgId).toBe(USER);
	});

	it("...and an org the caller is NOT a member of is still refused there", async () => {
		requestPath = "/not-my-org/evidence";
		orgRow = [];
		// Community refuses on the same membership join, and lands the same way. The edition changes
		// which org a RESOLVED slug maps to, never whether an unresolvable one is answered.
		await expect(currentActor()).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK/);
	});
});
