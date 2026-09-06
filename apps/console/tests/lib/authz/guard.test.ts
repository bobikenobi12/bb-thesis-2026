// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The REAL authorization guard (lib/authz/guard.ts). Mocked boundary: the PDP (getPdp),
// scope/owner resolution, the injected-actor seam, and the CLI token verifier. Asserts
// the actor-resolution precedence (injected > session), the personal-scope fallback,
// enforce/can wiring + arguments, and every ForbiddenError → 403 branch.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/owner", () => ({ getOwnerScope: vi.fn() }));
vi.mock("@/lib/auth/scope", () => ({ getActiveScope: vi.fn() }));
vi.mock("@/lib/authz", () => ({ getPdp: vi.fn() }));
vi.mock("@/lib/authz/actor-context", () => ({ getInjectedActor: vi.fn() }));
vi.mock("@/lib/cli/auth", () => ({ verifyCliToken: vi.fn() }));

// `isOrgMember` reads the `member` table, and the service-token branch below calls it on EVERY
// request. vi.hoisted because the factory is hoisted above every const in this file.
const { dbLimit } = vi.hoisted(() => ({ dbLimit: vi.fn() }));
vi.mock("@/lib/db", () => ({
	getServiceDb: () => ({ select: () => ({ from: () => ({ where: () => ({ limit: dbLimit }) }) }) }),
}));

import { getOwnerScope } from "@/lib/auth/owner";
import { getActiveScope } from "@/lib/auth/scope";
import { getPdp } from "@/lib/authz";
import { getInjectedActor } from "@/lib/authz/actor-context";
import { verifyCliToken } from "@/lib/cli/auth";
import { ForbiddenError, type Actor } from "@/lib/authz/types";

import {
	authorize,
	authorizeCli,
	authorizeQuiet,
	authorizeUserId,
	currentActor,
} from "@/lib/authz/guard";

const SESSION_ACTOR: Actor = { userId: "u-session", orgId: "org-session" };
const INJECTED_ACTOR: Actor = { userId: "u-mcp", orgId: "org-mcp" };
const CLI_ACTOR: Actor = { userId: "u-cli", orgId: "org-cli" };

const enforce = vi.fn();
const can = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	// Default PDP: allows everything.
	enforce.mockResolvedValue(undefined);
	can.mockResolvedValue({ allowed: true });
	vi.mocked(getPdp).mockReturnValue({
		enforce,
		can,
		bulkCheck: vi.fn(),
		listAccessible: vi.fn(),
	});
	// Default: no injected actor → session resolution path.
	vi.mocked(getInjectedActor).mockReturnValue(undefined);
	vi.mocked(getOwnerScope).mockResolvedValue({
		userId: "u-session",
		activeOrgId: "org-session",
	} as never);
	vi.mocked(getActiveScope).mockResolvedValue(SESSION_ACTOR);
});

describe("currentActor", () => {
	it("returns the injected actor without touching session resolution", async () => {
		vi.mocked(getInjectedActor).mockReturnValue(INJECTED_ACTOR);

		const actor = await currentActor();

		expect(actor).toBe(INJECTED_ACTOR);
		expect(getOwnerScope).not.toHaveBeenCalled();
		expect(getActiveScope).not.toHaveBeenCalled();
	});

	it("resolves from owner scope → getActiveScope(userId, activeOrgId) when not injected", async () => {
		const actor = await currentActor();

		expect(actor).toBe(SESSION_ACTOR);
		expect(getOwnerScope).toHaveBeenCalledTimes(1);
		expect(getActiveScope).toHaveBeenCalledWith("u-session", "org-session");
	});

	it("passes through an undefined activeOrgId (personal-scope fallback)", async () => {
		vi.mocked(getOwnerScope).mockResolvedValue({
			userId: "u-personal",
			activeOrgId: undefined,
		} as never);
		const personal: Actor = { userId: "u-personal", orgId: "u-personal" };
		vi.mocked(getActiveScope).mockResolvedValue(personal);

		const actor = await currentActor();

		// Personal org === userId in community.
		expect(actor.orgId).toBe(actor.userId);
		expect(getActiveScope).toHaveBeenCalledWith("u-personal", undefined);
	});
});

describe("authorize", () => {
	it("resolves the actor, enforces the verb with the exact ResourceRef, and returns the actor", async () => {
		const actor = await authorize("manage_connectors", { type: "connector", id: "c-1" });

		expect(actor).toBe(SESSION_ACTOR);
		expect(enforce).toHaveBeenCalledWith(SESSION_ACTOR, "manage_connectors", {
			type: "connector",
			id: "c-1",
		});
		expect(can).not.toHaveBeenCalled();
	});

	it("omits id (undefined) for create/list-style refs", async () => {
		await authorize("manage_connectors", { type: "connector" });

		expect(enforce).toHaveBeenCalledWith(SESSION_ACTOR, "manage_connectors", {
			type: "connector",
			id: undefined,
		});
	});

	it("propagates ForbiddenError from the PDP", async () => {
		const denial = new ForbiddenError("manage_connectors", { type: "connector" }, "no_grant");
		enforce.mockRejectedValueOnce(denial);

		await expect(authorize("manage_connectors", { type: "connector" })).rejects.toBe(denial);
	});
});

describe("authorizeQuiet", () => {
	it("uses can() (never enforce) and returns the actor when allowed", async () => {
		const actor = await authorizeQuiet("manage_connectors", { type: "connector", id: "c-2" });

		expect(actor).toBe(SESSION_ACTOR);
		expect(can).toHaveBeenCalledWith(SESSION_ACTOR, "manage_connectors", {
			type: "connector",
			id: "c-2",
		});
		expect(enforce).not.toHaveBeenCalled();
	});

	it("throws ForbiddenError (carrying the decision reason) when denied", async () => {
		can.mockResolvedValueOnce({ allowed: false, reason: "no_grant" });

		const err = await authorizeQuiet("manage_connectors", { type: "connector", id: "c-3" }).catch(
			(e) => e,
		);

		expect(err).toBeInstanceOf(ForbiddenError);
		expect(err.reason).toBe("no_grant");
		expect(err.action).toBe("manage_connectors");
		expect(err.resource).toEqual({ type: "connector", id: "c-3" });
	});
});

describe("authorizeCli", () => {
	const req = new Request("https://example.test/api/cli");

	it("returns the verifier's error Response when the token is invalid", async () => {
		const errorResponse = new Response("nope", { status: 401 });
		vi.mocked(verifyCliToken).mockResolvedValue({ payload: null, error: errorResponse } as never);

		const result = await authorizeCli(req, "manage_connectors", { type: "connector" });

		expect(result).toEqual({ error: errorResponse });
		expect("actor" in result).toBe(false);
		expect(getActiveScope).not.toHaveBeenCalled();
	});

	it("returns a 400 Response when the token payload has no subject", async () => {
		vi.mocked(verifyCliToken).mockResolvedValue({ payload: {}, error: undefined } as never);

		const result = await authorizeCli(req, "manage_connectors", { type: "connector" });

		expect("error" in result).toBe(true);
		const { error } = result as { error: Response };
		expect(error.status).toBe(400);
		await expect(error.json()).resolves.toEqual({ error: "Invalid token payload" });
	});

	it("resolves the actor from the token sub, enforces, and returns the actor", async () => {
		vi.mocked(verifyCliToken).mockResolvedValue({
			payload: { sub: "u-cli" },
			error: undefined,
		} as never);
		vi.mocked(getActiveScope).mockResolvedValue(CLI_ACTOR);

		const result = await authorizeCli(req, "manage_connectors", { type: "connector", id: "c-9" });

		expect(getActiveScope).toHaveBeenCalledWith("u-cli");
		expect(enforce).toHaveBeenCalledWith(CLI_ACTOR, "manage_connectors", {
			type: "connector",
			id: "c-9",
		});
		expect(result).toEqual({ actor: CLI_ACTOR });
	});

	it("maps a ForbiddenError to a 403 Response", async () => {
		vi.mocked(verifyCliToken).mockResolvedValue({
			payload: { sub: "u-cli" },
			error: undefined,
		} as never);
		vi.mocked(getActiveScope).mockResolvedValue(CLI_ACTOR);
		enforce.mockRejectedValueOnce(
			new ForbiddenError("manage_connectors", { type: "connector" }, "no_grant"),
		);

		const result = await authorizeCli(req, "manage_connectors", { type: "connector" });

		expect("error" in result).toBe(true);
		const { error } = result as { error: Response };
		expect(error.status).toBe(403);
		await expect(error.json()).resolves.toEqual({ error: "Forbidden" });
	});

	it("rethrows non-Forbidden errors", async () => {
		vi.mocked(verifyCliToken).mockResolvedValue({
			payload: { sub: "u-cli" },
			error: undefined,
		} as never);
		vi.mocked(getActiveScope).mockResolvedValue(CLI_ACTOR);
		const boom = new Error("pdp down");
		enforce.mockRejectedValueOnce(boom);

		await expect(authorizeCli(req, "manage_connectors", { type: "connector" })).rejects.toBe(boom);
	});
});

// ── X-Alethia-Org: THE SCOPE SERVED IS THE SCOPE NAMED (#3863). ──
//
// `isOrgMember` returns true when orgId === userId — a personal org's id IS the user id, so it
// has no `member` row and needs none. That made the header check pass for a value every caller
// can supply about themselves; the scope resolver then found no member row for it and fell back
// to the caller's EARLIEST membership, so `X-Alethia-Org: <own user id>` was answered with a TEAM
// org's rows. Not an escalation — the fallback lands on an org they belong to — but the request
// was answered from a scope it never named, and `jobs cancel --latest` resolves through the same
// list.
//
// Two halves close it, and this file owns the second: ee/src/scope.ts resolves a personal org to
// itself (ee/src/scope.test.ts), and authorizeCli refuses ANY scope that is not the org the header
// named, rather than serving the substitute.
describe("authorizeCli with an X-Alethia-Org header", () => {
	/** A request from an ordinary (non-service) CLI token, carrying an org header. */
	function headerReq(headerOrg: string): Request {
		const headers = new Headers({ "X-Alethia-Org": headerOrg });
		return new Request("https://example.test/api/cli", { headers });
	}

	beforeEach(() => {
		vi.mocked(verifyCliToken).mockResolvedValue({
			payload: { sub: "u-cli", type: "access" },
			error: undefined,
		} as never);
	});

	// THE ONE THAT MATTERS. The header names the caller's own user id — the personal org — and
	// resolution comes back pointing at a team org. That is exactly the #3863 sequence, and the
	// answer is a refusal.
	it("REFUSES when resolution lands on an org other than the one the header named", async () => {
		// The member check passes on the personal-org branch without touching the database: if
		// this ever needs a row, the branch under test has moved.
		vi.mocked(getActiveScope).mockResolvedValue({ userId: "u-cli", orgId: "org-team" });

		const result = await authorizeCli(headerReq("u-cli"), "manage_connectors", {
			type: "connector",
		});

		expect("error" in result).toBe(true);
		expect((result as { error: Response }).error.status).toBe(403);
		// The 403 came from the scope check and from NOTHING ELSE. Without this the same status
		// would be produced by a PDP denial, an invalid token or a missing member row, and the
		// test would pass while measuring a mechanism it is not about.
		expect(getActiveScope).toHaveBeenCalledWith("u-cli", "u-cli");
		expect(enforce).not.toHaveBeenCalled();
		expect(dbLimit).not.toHaveBeenCalled();
	});

	// The other side of the same branch: the header IS honoured when resolution agrees with it,
	// so the refusal above is not simply "personal-org headers are rejected".
	it("scopes to the caller's PERSONAL org when the header names it and resolution agrees", async () => {
		vi.mocked(getActiveScope).mockResolvedValue({ userId: "u-cli", orgId: "u-cli" });

		const result = await authorizeCli(headerReq("u-cli"), "manage_connectors", {
			type: "connector",
		});

		expect(result).toEqual({ actor: { userId: "u-cli", orgId: "u-cli" } });
		// The literal, not `actor.userId`: the team org the old fallback served was "org-team".
		expect((result as { actor: Actor }).actor.orgId).toBe("u-cli");
		expect(enforce).toHaveBeenCalledWith({ userId: "u-cli", orgId: "u-cli" }, "manage_connectors", {
			type: "connector",
			id: undefined,
		});
	});

	it("honours a header naming a team org the caller is a member of", async () => {
		dbLimit.mockResolvedValue([{ id: "m-1" }]);
		vi.mocked(getActiveScope).mockResolvedValue({ userId: "u-cli", orgId: "org-team" });

		const result = await authorizeCli(headerReq("org-team"), "manage_connectors", {
			type: "connector",
		});

		expect(result).toEqual({ actor: { userId: "u-cli", orgId: "org-team" } });
		expect(getActiveScope).toHaveBeenCalledWith("u-cli", "org-team");
	});

	it("REFUSES a header naming an org with no member row, resolving no scope at all", async () => {
		dbLimit.mockResolvedValue([]);

		const result = await authorizeCli(headerReq("org-stranger"), "manage_connectors", {
			type: "connector",
		});

		expect("error" in result).toBe(true);
		expect((result as { error: Response }).error.status).toBe(403);
		expect(getActiveScope).not.toHaveBeenCalled();
		expect(enforce).not.toHaveBeenCalled();
	});

	// AN ERROR IS NOT AN ABSENCE. A failed membership read must not render as "not a member" —
	// that is one blip away from a 403 storm indistinguishable from a real denial, and one
	// inverted branch away from the silent wrong scope this whole describe block is about.
	it("propagates a member-lookup failure instead of turning it into a denial", async () => {
		const boom = new Error("connection terminated");
		dbLimit.mockRejectedValue(boom);

		await expect(
			authorizeCli(headerReq("org-team"), "manage_connectors", { type: "connector" }),
		).rejects.toBe(boom);
	});

	it("propagates a scope-resolution failure instead of turning it into a denial", async () => {
		const boom = new Error("connection terminated");
		dbLimit.mockResolvedValue([{ id: "m-1" }]);
		vi.mocked(getActiveScope).mockRejectedValue(boom);

		await expect(
			authorizeCli(headerReq("org-team"), "manage_connectors", { type: "connector" }),
		).rejects.toBe(boom);
	});

	// The no-header path has no named org to compare against — resolving the caller's default
	// scope IS the intent there, so it must not acquire a refusal it never asked for.
	it("leaves the header-less path resolving the default scope", async () => {
		vi.mocked(getActiveScope).mockResolvedValue(CLI_ACTOR);

		const result = await authorizeCli(
			new Request("https://example.test/api/cli"),
			"manage_connectors",
			{ type: "connector" },
		);

		expect(result).toEqual({ actor: CLI_ACTOR });
		expect(getActiveScope).toHaveBeenCalledWith("u-cli");
	});
});

// ── SERVICE-ACCOUNT TOKENS: the organization pin. ──
//
// A service token's org is fixed when it is minted. An interactive session picks its org with an
// `X-Alethia-Org` header, which is safe because a human's own memberships bound it; a machine
// credential has no human behind it, so honouring that header would let a token issued to one tenant
// act on another. CLI routes query via getServiceDb() with NO RLS beneath them, so this branch IS the
// tenancy boundary for anything driven from a pipeline.
//
// Asserted here as BEHAVIOUR rather than as source text: the Go-side equivalent was caught by the
// anti-vacuity tripwire for scanning source and executing none of the code, and this is the same
// property on the other side of the wire.
describe("authorizeCli with a service-account token", () => {
	const SERVICE_ACTOR: Actor = { userId: "u-minter", orgId: "org-A" };

	/** A request carrying a service-token payload, optionally scoped by an org header. */
	function serviceReq(headerOrg?: string): Request {
		const headers = new Headers();
		if (headerOrg) headers.set("X-Alethia-Org", headerOrg);
		return new Request("https://example.test/api/cli", { headers });
	}

	beforeEach(() => {
		vi.mocked(verifyCliToken).mockResolvedValue({
			payload: { sub: "u-minter", type: "access", service_token_org_id: "org-A", service_token_id: "tok-1" },
			error: undefined,
		} as never);
		vi.mocked(getActiveScope).mockResolvedValue(SERVICE_ACTOR);
		// The minting profile is a member of org-A by default.
		dbLimit.mockResolvedValue([{ id: "m-1" }]);
	});

	it("scopes to the token's own org when no header is sent", async () => {
		const result = await authorizeCli(serviceReq(), "manage_tokens", { type: "org" });

		// The PINNED org, not `getActiveScope(userId)` — which would resolve whichever org that
		// PERSON last had active, i.e. somebody's session state standing in for a machine's scope.
		expect(getActiveScope).toHaveBeenCalledWith("u-minter", "org-A");
		expect(result).toEqual({ actor: SERVICE_ACTOR });
	});

	it("accepts a header that AGREES with the token's org", async () => {
		const result = await authorizeCli(serviceReq("org-A"), "manage_tokens", { type: "org" });

		expect(getActiveScope).toHaveBeenCalledWith("u-minter", "org-A");
		expect(result).toEqual({ actor: SERVICE_ACTOR });
	});

	// THE ONE THAT MATTERS. Refused, never ignored: ignoring it would let a pipeline believe it is
	// writing to org B while every write lands in org A — a wrong answer that looks like a right one.
	it("REFUSES a header naming a different org, and resolves no scope at all", async () => {
		const result = await authorizeCli(serviceReq("org-B"), "manage_tokens", { type: "org" });

		expect("error" in result).toBe(true);
		expect((result as { error: Response }).error.status).toBe(403);
		expect(getActiveScope).not.toHaveBeenCalled();
		expect(enforce).not.toHaveBeenCalled();
	});

	// Membership is re-checked on EVERY request rather than trusted from mint time — otherwise
	// revoking somebody's access would leave their tokens live, which is the offboarding hole
	// long-lived credentials are known for.
	it("REFUSES when the minting profile is no longer a member of the token's org", async () => {
		dbLimit.mockResolvedValue([]);

		const result = await authorizeCli(serviceReq(), "manage_tokens", { type: "org" });

		expect("error" in result).toBe(true);
		expect((result as { error: Response }).error.status).toBe(403);
		expect(enforce).not.toHaveBeenCalled();
	});

	// The pin is a NAMED org exactly as a header is, so it gets the same #3863 treatment: the scope
	// served must BE the pinned org. A token pinned to its minter's personal org would otherwise
	// resolve through the same missing-member-row fallback and drive a pipeline against a team org
	// nobody named — the "writing to org B while every write lands in org A" failure this block
	// already refuses in its header form.
	it("REFUSES when the pinned org resolves to a different scope", async () => {
		vi.mocked(getActiveScope).mockResolvedValue({ userId: "u-minter", orgId: "org-B" });

		const result = await authorizeCli(serviceReq(), "manage_tokens", { type: "org" });

		expect("error" in result).toBe(true);
		expect((result as { error: Response }).error.status).toBe(403);
		// From the scope check, not from the PDP or the membership re-check.
		expect(dbLimit).toHaveBeenCalled();
		expect(getActiveScope).toHaveBeenCalledWith("u-minter", "org-A");
		expect(enforce).not.toHaveBeenCalled();
	});

	// The pin decides SCOPE; it does not grant permission. The PDP still rules on the action, and a
	// denial is a 403 like any other — a service token is not a way around authorization.
	it("still defers to the PDP, mapping a ForbiddenError to 403", async () => {
		enforce.mockRejectedValueOnce(
			new ForbiddenError("manage_tokens", { type: "org" }, "no_grant"),
		);

		const result = await authorizeCli(serviceReq(), "manage_tokens", { type: "org" });

		expect("error" in result).toBe(true);
		expect((result as { error: Response }).error.status).toBe(403);
	});

	it("rethrows a non-Forbidden PDP error rather than turning it into a denial", async () => {
		const boom = new Error("pdp down");
		enforce.mockRejectedValueOnce(boom);

		await expect(authorizeCli(serviceReq(), "manage_tokens", { type: "org" })).rejects.toBe(boom);
	});
});

describe("authorizeUserId", () => {
	it("resolves the actor, enforces, and returns null when allowed", async () => {
		vi.mocked(getActiveScope).mockResolvedValue(CLI_ACTOR);

		const result = await authorizeUserId("u-cli", "manage_connectors", {
			type: "connector",
			id: "c-7",
		});

		expect(result).toBeNull();
		expect(getActiveScope).toHaveBeenCalledWith("u-cli");
		expect(enforce).toHaveBeenCalledWith(CLI_ACTOR, "manage_connectors", {
			type: "connector",
			id: "c-7",
		});
	});

	it("returns a 403 Response on ForbiddenError", async () => {
		vi.mocked(getActiveScope).mockResolvedValue(CLI_ACTOR);
		enforce.mockRejectedValueOnce(
			new ForbiddenError("manage_connectors", { type: "connector" }, "no_grant"),
		);

		const result = await authorizeUserId("u-cli", "manage_connectors", { type: "connector" });

		expect(result).not.toBeNull();
		expect(result?.status).toBe(403);
		await expect(result?.json()).resolves.toEqual({ error: "Forbidden" });
	});

	it("rethrows non-Forbidden errors", async () => {
		vi.mocked(getActiveScope).mockResolvedValue(CLI_ACTOR);
		const boom = new Error("pdp down");
		enforce.mockRejectedValueOnce(boom);

		await expect(
			authorizeUserId("u-cli", "manage_connectors", { type: "connector" }),
		).rejects.toBe(boom);
	});
});
