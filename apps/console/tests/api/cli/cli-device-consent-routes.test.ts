// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The three routes #3889 and #3887 add (/start, /request, /deny) and the two they change
// (/generate, /exchange).
//
// What a user could do before them, and must not be able to do after:
//   · press "This isn't me", have it change NOTHING on the server, and re-approve the same
//     link a moment later (#3887);
//   · approve a device code with ANY well-formed user_code, because the code on screen was
//     shape-checked and never compared against a stored one (#3889);
//   · consent to "a device is asking to sign in" while the press also hands over a 90-day
//     refresh token and a raw git-provider OAuth token (#3889).
//
// And the one thing that must NOT become possible: denying somebody else's in-flight login.
// An unauthenticated /deny is a cheap denial of service on `alethia login`.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("@/lib/auth", () => ({
	auth: {
		api: {
			getSession: vi.fn(),
			listUserAccounts: vi.fn(),
			getAccessToken: vi.fn(),
		},
	},
}));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));

import { POST as DENY } from "@/app/api/auth/cli/deny/route";
import { POST as EXCHANGE } from "@/app/api/auth/cli/exchange/route";
import { POST as GENERATE } from "@/app/api/auth/cli/generate/route";
import { GET as REQUEST } from "@/app/api/auth/cli/request/route";
import { POST as START } from "@/app/api/auth/cli/start/route";
import { auth } from "@/lib/auth";
import {
	CLI_DEVICE_START_RATE_LIMIT,
	PENDING_DEVICE_CODE_TTL_MS,
} from "@/lib/auth/cli-device-code";
import { getServiceDb } from "@/lib/db";
import { headers } from "next/headers";

const DEVICE_CODE = "2f1c8c1e-7a4b-4d2e-9a3f-0b5c6d7e8f90";
const USER_CODE = "BCDF-GHJK";
const OTHER_USER_CODE = "MNPQ-RSTV";
const OWNER = "victim";

/** One statement the route issued, as the fake db saw it. */
interface ConsentOp {
	kind: "select" | "insert" | "update" | "delete";
	where?: unknown;
	values?: Record<string, unknown>;
	conflict?: "doUpdate" | "doNothing";
	conflictSet?: Record<string, unknown>;
	conflictWhere?: unknown;
}

/**
 * A drizzle-ish chain: every builder returns the chain, and every `await` resolves to the
 * next seeded result-set (FIFO), so each sequential query gets its own rows. It also
 * RECORDS each statement, because several of the properties under test are about the
 * predicate a statement carries rather than the rows it returns — the exchange's claiming
 * DELETE, for one, is now only correct because of what it refuses to delete.
 */
function consentDb() {
	const queue: unknown[][] = [];
	const ops: ConsentOp[] = [];
	let current: ConsentOp | null = null;
	const db: Record<string, unknown> = {};
	const start = (kind: ConsentOp["kind"]) => {
		current = { kind };
		ops.push(current);
		return db;
	};
	Object.assign(db, {
		select: () => start("select"),
		insert: () => start("insert"),
		update: () => start("update"),
		delete: () => start("delete"),
		from: () => db,
		limit: () => db,
		leftJoin: () => db,
		returning: () => db,
		where: (w: unknown) => {
			if (current) current.where = w;
			return db;
		},
		values: (v: Record<string, unknown>) => {
			if (current) current.values = v;
			return db;
		},
		// drizzle's UPDATE payload. Recorded into `values` so an update reads like an insert
		// at the assertion site — what is under test is the pair (payload, predicate), and
		// that is the same question for both.
		set: (v: Record<string, unknown>) => {
			if (current) current.values = v;
			return db;
		},
		onConflictDoUpdate: (cfg: { set: Record<string, unknown>; setWhere?: unknown }) => {
			if (current) {
				current.conflict = "doUpdate";
				current.conflictSet = cfg.set;
				current.conflictWhere = cfg.setWhere;
			}
			return db;
		},
		onConflictDoNothing: () => {
			if (current) current.conflict = "doNothing";
			return db;
		},
		// An UPDATE does not consume a seeded result-set. Nothing awaits rows from one here —
		// the scrub is bookkeeping — and letting it shift the FIFO would make every test that
		// seeds a later SELECT depend on how many housekeeping statements the route happens to
		// issue. That coupling is how adding one statement broke two unrelated assertions.
		then: (resolve: (v: unknown) => void) =>
			resolve(current?.kind === "update" ? [] : queue.length ? queue.shift() : []),
	});
	return { db, queue, ops };
}

let fake: ReturnType<typeof consentDb>;

/** A POST Request carrying `body`, optionally with extra headers. */
function post(path: string, body: unknown, extra: Record<string, string> = {}): Request {
	return new Request(`https://console.local${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", ...extra },
		body: JSON.stringify(body),
	});
}

/** A GET Request for the read endpoint. */
function get(query: string): Request {
	return new Request(`https://console.local/api/auth/cli/request?${query}`, {
		method: "GET",
	});
}

/**
 * Collects every column name and SQL fragment inside a drizzle condition, so a test can
 * assert on the SHAPE of a predicate rather than on an opaque object. Recursive because
 * `and(eq(…), isNull(…))` nests SQL inside SQL.
 */
function sqlTerms(node: unknown, out: string[] = []): string[] {
	if (node === null || node === undefined) return out;
	if (typeof node === "string") {
		const t = node.trim().toLowerCase();
		if (t) out.push(t);
		return out;
	}
	if (Array.isArray(node)) {
		for (const child of node) sqlTerms(child, out);
		return out;
	}
	if (typeof node !== "object") return out;
	const o = node as Record<string, unknown>;
	// A drizzle Column carries `name` and a `table`; a StringChunk carries `value`.
	if (typeof o.name === "string" && "table" in o) out.push(o.name.toLowerCase());
	if ("value" in o) sqlTerms(o.value, out);
	if ("queryChunks" in o) sqlTerms(o.queryChunks, out);
	return out;
}

beforeEach(() => {
	vi.clearAllMocks();
	fake = consentDb();
	vi.mocked(getServiceDb).mockReturnValue(fake.db as never);
	vi.mocked(headers).mockResolvedValue(new Headers() as never);
	vi.mocked(auth.api.getSession).mockResolvedValue({
		user: { id: OWNER, email: "ada@example.com", name: "Ada" },
	} as never);
	vi.mocked(auth.api.listUserAccounts).mockResolvedValue([] as never);
	process.env.CLI_JWT_SECRET = "test-cli-jwt-secret";
});

// The probe the predicate assertions below lean on. If `sqlTerms` ever stopped seeing
// column names — a drizzle upgrade reshaping its AST would do it — every one of those
// assertions would pass vacuously against an empty list. This is the control.
describe("the predicate probe", () => {
	it("sees the columns and operators inside a nested condition", async () => {
		const { and, eq, isNull, isNotNull } = await import("drizzle-orm");
		const { cliLogins } = await import("@/lib/db/schema");
		const terms = sqlTerms(
			and(
				eq(cliLogins.device_code, DEVICE_CODE),
				isNotNull(cliLogins.profile_id),
				isNull(cliLogins.denied_at),
			),
		);
		expect(terms).toContain("device_code");
		expect(terms).toContain("profile_id");
		expect(terms).toContain("denied_at");
		expect(terms.join(" ")).toContain("is not null");
		expect(terms.join(" ")).toContain("is null");
	});
});

describe("POST /api/auth/cli/start", () => {
	it("refuses a malformed device_code or user_code", async () => {
		expect(
			(await START(post("/api/auth/cli/start", { device_code: "nope", user_code: USER_CODE })))
				.status,
		).toBe(400);
		expect(
			(await START(post("/api/auth/cli/start", { device_code: DEVICE_CODE, user_code: "nope" })))
				.status,
		).toBe(400);
		expect(fake.ops.some((o) => o.kind === "insert")).toBe(false);
	});

	it("registers the user_code, the requester and a pending deadline", async () => {
		fake.queue.push([], [], [{ user_code: USER_CODE }]);
		const res = await START(
			post(
				"/api/auth/cli/start",
				{
					device_code: DEVICE_CODE,
					user_code: USER_CODE,
					client_name: "alethia-cli",
					client_version: "0.42.1",
				},
				{ "user-agent": "alethia-cli/0.42.1 (darwin; arm64)", "cf-connecting-ip": "203.0.113.7" },
			),
		);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			expires_in: PENDING_DEVICE_CODE_TTL_MS / 1000,
			interval: 2,
		});

		const insert = fake.ops.find((o) => o.kind === "insert");
		expect(insert?.values).toMatchObject({
			device_code: DEVICE_CODE,
			user_code: USER_CODE,
			request_ip: "203.0.113.7",
			client_metadata: {
				client_name: "alethia-cli",
				client_version: "0.42.1",
				user_agent: "alethia-cli/0.42.1 (darwin; arm64)",
			},
		});
		const deadline = insert?.values?.pending_expires_at as Date;
		expect(deadline).toBeInstanceOf(Date);
		expect(deadline.getTime()).toBeGreaterThan(Date.now());
	});

	// The whole safety property of an UNAUTHENTICATED write. An upsert here would let
	// anyone who learns a device_code repoint an already-approved request's displayed
	// metadata, or reset a refusal somebody made.
	it("never overwrites an existing row", async () => {
		fake.queue.push([], [], [{ user_code: USER_CODE }]);
		await START(post("/api/auth/cli/start", { device_code: DEVICE_CODE, user_code: USER_CODE }));
		const insert = fake.ops.find((o) => o.kind === "insert");
		expect(insert?.conflict).toBe("doNothing");
	});

	it("refuses a device_code already registered under a different user_code", async () => {
		fake.queue.push([], [], [{ user_code: OTHER_USER_CODE }]);
		const res = await START(
			post("/api/auth/cli/start", { device_code: DEVICE_CODE, user_code: USER_CODE }),
		);
		expect(res.status).toBe(409);
	});

	// The failure class this repo keeps hitting: a "nothing found" branch indistinguishable
	// from "nothing wrong". A read-back that finds no row means the registration this route
	// is about to report as done did not happen — not that everything is fine.
	it("does not report success when the read-back finds nothing", async () => {
		fake.queue.push([], [], []);
		const res = await START(
			post("/api/auth/cli/start", { device_code: DEVICE_CODE, user_code: USER_CODE }),
		);
		expect(res.status).toBe(500);
	});

	// Undecided rows carry a request IP, have no profile_id, and so are outside the reach of
	// the subject-erasure plan. Nothing else deletes them.
	it("sweeps stale UNDECIDED rows before adding another", async () => {
		fake.queue.push([], [], [{ user_code: USER_CODE }]);
		await START(post("/api/auth/cli/start", { device_code: DEVICE_CODE, user_code: USER_CODE }));

		const sweep = fake.ops.find((o) => o.kind === "delete");
		expect(sweep).toBeDefined();
		const terms = sqlTerms(sweep?.where);
		expect(terms).toContain("profile_id");
		expect(terms).toContain("created_at");
		// Scoped to unowned rows: an approved row is somebody's live login.
		expect(terms.join(" ")).toContain("is null");
		// AND to undecided ones. See the next two tests for why this is the whole fix.
		expect(terms).toContain("denied_at");
	});

	// THE REFUSAL HAS TO OUTLIVE ITS WINDOW, and this is the test that says so.
	//
	// `onConflictDoNothing` on the insert below is the only thing stopping a refused
	// device_code being re-registered, and it can only refuse a row that still EXISTS. The
	// first cut of this route swept denial markers on the same `created_at` bound as
	// undecided ones, reasoning that a denial's window is over by definition — which handed
	// the attacker the same phished link back ten minutes later. That is #3887's own defect,
	// "declining is not durable", reintroduced on a timer.
	it("does NOT delete a refusal, or the same phished link becomes approvable again", async () => {
		fake.queue.push([], [], [{ user_code: USER_CODE }]);
		await START(post("/api/auth/cli/start", { device_code: DEVICE_CODE, user_code: USER_CODE }));

		const sweep = fake.ops.find((o) => o.kind === "delete");
		// A DELETE that does not mention denied_at reaches every refusal in the table.
		expect(sqlTerms(sweep?.where)).toContain("denied_at");
	});

	// …and the retention argument that motivated deleting them is still answered: the marker
	// is kept, the SUBJECT is not. What survives is a random 122-bit device_code, its
	// user_code and a timestamp.
	it("scrubs a stale refusal's personal data instead of deleting the marker", async () => {
		fake.queue.push([], [], [{ user_code: USER_CODE }]);
		await START(post("/api/auth/cli/start", { device_code: DEVICE_CODE, user_code: USER_CODE }));

		const scrub = fake.ops.find((o) => o.kind === "update");
		expect(scrub, "no UPDATE — a refused row keeps its request_ip forever").toBeDefined();
		expect(scrub?.values).toHaveProperty("request_ip", null);
		expect(scrub?.values).toHaveProperty("client_metadata", null);
		const terms = sqlTerms(scrub?.where);
		expect(terms).toContain("denied_at");
		expect(terms).toContain("created_at");
		// Never an approved row: that is somebody's live login and its IP is theirs.
		expect(terms).toContain("profile_id");
	});

	it("throttles on its own, tighter budget", async () => {
		const ip = "198.51.100.42";
		let last: Response | undefined;
		for (let i = 0; i <= CLI_DEVICE_START_RATE_LIMIT.limit; i++) {
			fake.queue.push([], [], [{ user_code: USER_CODE }]);
			last = await START(
				post(
					"/api/auth/cli/start",
					{ device_code: DEVICE_CODE, user_code: USER_CODE },
					{ "cf-connecting-ip": ip },
				),
			);
		}
		expect(last?.status).toBe(429);
	});
});

describe("POST /api/auth/cli/deny", () => {
	// THE gate on this route. Without a session, anyone able to reach the endpoint could
	// terminate somebody else's in-flight `alethia login` — a cheap denial of service, and
	// the reason the refusal endpoint could not simply mirror the unauthenticated exchange.
	it("is unreachable without a session, and touches nothing", async () => {
		vi.mocked(auth.api.getSession).mockResolvedValue(null as never);
		const res = await DENY(
			post("/api/auth/cli/deny", { device_code: DEVICE_CODE, user_code: USER_CODE }),
		);
		expect(res.status).toBe(401);
		expect(fake.ops).toHaveLength(0);
	});

	it("refuses a malformed device_code or user_code", async () => {
		expect(
			(await DENY(post("/api/auth/cli/deny", { device_code: "nope", user_code: USER_CODE })))
				.status,
		).toBe(400);
		expect(
			(await DENY(post("/api/auth/cli/deny", { device_code: DEVICE_CODE, user_code: "x" })))
				.status,
		).toBe(400);
		expect(fake.ops.some((o) => o.kind === "insert")).toBe(false);
	});

	// Denying is destructive to somebody's login, so the takeover gate cuts both ways: a
	// code bound to another account is not yours to refuse either.
	it("refuses a device code that belongs to another account", async () => {
		fake.queue.push([{ profile_id: "someone-else", user_code: USER_CODE }]);
		const res = await DENY(
			post("/api/auth/cli/deny", { device_code: DEVICE_CODE, user_code: USER_CODE }),
		);
		expect(res.status).toBe(409);
		expect(fake.ops.some((o) => o.kind === "insert")).toBe(false);
	});

	it("refuses a user_code that disagrees with the registered one", async () => {
		fake.queue.push([{ profile_id: null, user_code: OTHER_USER_CODE }]);
		const res = await DENY(
			post("/api/auth/cli/deny", { device_code: DEVICE_CODE, user_code: USER_CODE }),
		);
		expect(res.status).toBe(409);
		expect(fake.ops.some((o) => o.kind === "insert")).toBe(false);
	});

	it("writes a durable refusal and revokes anything already stashed", async () => {
		fake.queue.push(
			[{ profile_id: null, user_code: USER_CODE }],
			[],
			[{ denied_at: new Date() }],
		);
		const res = await DENY(
			post("/api/auth/cli/deny", { device_code: DEVICE_CODE, user_code: USER_CODE }),
		);

		expect(res.status).toBe(200);
		const write = fake.ops.find((o) => o.kind === "insert");
		expect(write?.values?.denied_at).toBeInstanceOf(Date);
		// A refusal arriving after an approval revokes it, rather than leaving a row that
		// reads as both approved and denied. verification_code is the stashed raw
		// git-provider OAuth token.
		expect(write?.conflictSet).toMatchObject({
			profile_id: null,
			verification_code: null,
			refresh_token: null,
		});
		expect(write?.conflictSet?.denied_at).toBeInstanceOf(Date);
	});

	// The screen says "the refusal has been recorded". A write that silently did nothing
	// would make that sentence a lie in exactly the case where it matters.
	it("does not claim the refusal was recorded when the marker is absent", async () => {
		fake.queue.push([{ profile_id: null, user_code: USER_CODE }], [], [{ denied_at: null }]);
		const res = await DENY(
			post("/api/auth/cli/deny", { device_code: DEVICE_CODE, user_code: USER_CODE }),
		);
		expect(res.status).toBe(500);
	});
});

describe("POST /api/auth/cli/generate", () => {
	// #3887's durability half. Without it, "This isn't me" is undone by re-opening the same
	// link and pressing Approve — which is precisely what a "click it again, it glitched"
	// follow-up asks the user to do.
	it("refuses to approve a refused device code", async () => {
		fake.queue.push([{ profile_id: null, user_code: USER_CODE, denied_at: new Date() }]);
		const res = await GENERATE(
			post("/api/auth/cli/generate", { device_code: DEVICE_CODE, user_code: USER_CODE }),
		);
		expect(res.status).toBe(409);
		expect((await res.json()).error).toMatch(/refused/i);
		expect(fake.ops.some((o) => o.kind === "insert")).toBe(false);
	});

	// #3889's binding half. Before it, the user_code was shape-checked and never compared,
	// so ANY well-formed code approved any registered device code.
	it("refuses a user_code that disagrees with the registered one", async () => {
		fake.queue.push([{ profile_id: null, user_code: OTHER_USER_CODE, denied_at: null }]);
		const res = await GENERATE(
			post("/api/auth/cli/generate", { device_code: DEVICE_CODE, user_code: USER_CODE }),
		);
		expect(res.status).toBe(409);
		expect(fake.ops.some((o) => o.kind === "insert")).toBe(false);
	});

	// The negative direction: a legitimate approval must still work, and must bind the code
	// on BOTH write paths so a row that reached approval without a registration still ends
	// up carrying the code it was approved with.
	it("still approves a matching request, and binds the user_code", async () => {
		fake.queue.push(
			[{ profile_id: null, user_code: USER_CODE, denied_at: null }],
			[],
			[{ profile_id: OWNER }],
		);
		const res = await GENERATE(
			post("/api/auth/cli/generate", { device_code: DEVICE_CODE, user_code: USER_CODE }),
		);

		expect(res.status).toBe(200);
		const write = fake.ops.find((o) => o.kind === "insert");
		expect(write?.values?.user_code).toBe(USER_CODE);
		expect(write?.conflictSet?.user_code).toBe(USER_CODE);
		// The race between the ownership SELECT and this write is closed on denied_at too,
		// so a refusal landing in between is not overwritten by the approval it raced.
		expect(sqlTerms(write?.conflictWhere)).toContain("denied_at");
	});

	it("approves an unregistered request, so an older CLI can still log in", async () => {
		fake.queue.push([], [], [{ profile_id: OWNER }]);
		const res = await GENERATE(
			post("/api/auth/cli/generate", { device_code: DEVICE_CODE, user_code: USER_CODE }),
		);
		expect(res.status).toBe(200);
	});
});

describe("POST /api/auth/cli/exchange", () => {
	// #3887's signalling half. The CLI polling this endpoint used to spin to its own
	// ten-minute timeout after a refusal, so the person who pressed "This isn't me" gave the
	// terminal — in the phishing case, the ATTACKER's terminal — no signal at all.
	it("answers a refused code with RFC 8628's access_denied", async () => {
		fake.queue.push([], [{ denied_at: new Date() }]);
		const res = await EXCHANGE(post("/api/auth/cli/exchange", { device_code: DEVICE_CODE }));

		expect(res.status).toBe(403);
		expect(await res.json()).toMatchObject({ error: "access_denied" });
	});

	// A pending registration is what the consent screen renders from. An unnarrowed
	// claiming DELETE would remove it on the CLI's very first poll — two seconds after the
	// browser opened — and the screen would lose its contents mid-decision.
	it("leaves an unapproved registration in place and reports it as pending", async () => {
		fake.queue.push([], [{ denied_at: null }]);
		const res = await EXCHANGE(post("/api/auth/cli/exchange", { device_code: DEVICE_CODE }));

		expect(res.status).toBe(404);
		const claim = fake.ops.find((o) => o.kind === "delete");
		const terms = sqlTerms(claim?.where);
		expect(terms).toContain("profile_id");
		expect(terms).toContain("denied_at");
		expect(terms.join(" ")).toContain("is not null");
	});

	// The negative direction again: narrowing the claim must not stop a real redemption.
	it("still redeems an approved code for a token pair", async () => {
		fake.queue.push(
			[
				{
					profile_id: OWNER,
					verification_code: "gho_stashed",
					expires_at: new Date(Date.now() + 60_000),
					created_at: new Date(),
				},
			],
			[{ email: "ada@example.com" }],
		);
		const res = await EXCHANGE(post("/api/auth/cli/exchange", { device_code: DEVICE_CODE }));

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.access_token).toEqual(expect.any(String));
		expect(body.refresh_token).toEqual(expect.any(String));
		expect(body.provider_token).toBe("gho_stashed");
	});
});

describe("GET /api/auth/cli/request", () => {
	it("is unreachable without a session", async () => {
		vi.mocked(auth.api.getSession).mockResolvedValue(null as never);
		const res = await REQUEST(get(`device_code=${DEVICE_CODE}&user_code=${USER_CODE}`));
		expect(res.status).toBe(401);
		expect(fake.ops).toHaveLength(0);
	});

	it("refuses a malformed device_code or user_code", async () => {
		expect((await REQUEST(get(`device_code=nope&user_code=${USER_CODE}`))).status).toBe(400);
		expect((await REQUEST(get(`device_code=${DEVICE_CODE}&user_code=nope`))).status).toBe(400);
	});

	// 404, not an empty view: the page has to be able to tell "this request carries no
	// server-verified detail" from "it carries detail and the detail is blank".
	it("answers 404 for a request that was never registered", async () => {
		fake.queue.push([]);
		const res = await REQUEST(get(`device_code=${DEVICE_CODE}&user_code=${USER_CODE}`));
		expect(res.status).toBe(404);
	});

	it("refuses a user_code that disagrees with the registered one", async () => {
		fake.queue.push([
			{
				profile_id: null,
				user_code: OTHER_USER_CODE,
				client_metadata: null,
				request_ip: null,
				pending_expires_at: null,
				denied_at: null,
			},
		]);
		const res = await REQUEST(get(`device_code=${DEVICE_CODE}&user_code=${USER_CODE}`));
		expect(res.status).toBe(409);
	});

	it("refuses a request bound to another account", async () => {
		fake.queue.push([
			{
				profile_id: "someone-else",
				user_code: USER_CODE,
				client_metadata: null,
				request_ip: null,
				pending_expires_at: null,
				denied_at: null,
			},
		]);
		const res = await REQUEST(get(`device_code=${DEVICE_CODE}&user_code=${USER_CODE}`));
		expect(res.status).toBe(409);
	});

	// Everything #3889 says the screen does not name: which account, what is handed over,
	// who is asking, and how long is left.
	it("names the account, the requester, the scopes and the deadline", async () => {
		const deadline = new Date(Date.now() + 5 * 60_000);
		vi.mocked(auth.api.listUserAccounts).mockResolvedValue([
			{ id: "acct-1", providerId: "github" },
		] as never);
		fake.queue.push([
			{
				profile_id: null,
				user_code: USER_CODE,
				client_metadata: {
					client_name: "alethia-cli",
					client_version: "0.42.1",
					user_agent: "alethia-cli/0.42.1 (darwin; arm64)",
				},
				request_ip: "203.0.113.7",
				pending_expires_at: deadline,
				denied_at: null,
			},
		]);

		const res = await REQUEST(get(`device_code=${DEVICE_CODE}&user_code=${USER_CODE}`));
		expect(res.status).toBe(200);
		const body = await res.json();

		expect(body.status).toBe("pending");
		expect(body.account).toEqual({ email: "ada@example.com", name: "Ada" });
		expect(body.requester).toEqual({
			client_name: "alethia-cli",
			client_version: "0.42.1",
			user_agent: "alethia-cli/0.42.1 (darwin; arm64)",
			request_ip: "203.0.113.7",
		});
		expect(body.expires_at).toBe(deadline.toISOString());
		// The git-provider token is the part the old copy did not name at all.
		expect(body.scopes.map((s: { id: string }) => s.id)).toContain("git_provider_token");
		// The REGISTERED code, not the one from the query string — that is what makes this
		// field mean "what the terminal printed" rather than "what the link said".
		expect(body.user_code).toBe(USER_CODE);
	});

	it("reports a request whose decision window has closed as expired", async () => {
		fake.queue.push([
			{
				profile_id: null,
				user_code: USER_CODE,
				client_metadata: null,
				request_ip: null,
				pending_expires_at: new Date(Date.now() - 1_000),
				denied_at: null,
			},
		]);
		const res = await REQUEST(get(`device_code=${DEVICE_CODE}&user_code=${USER_CODE}`));
		expect((await res.json()).status).toBe("expired");
	});

	it("reports a refused request as denied", async () => {
		fake.queue.push([
			{
				profile_id: null,
				user_code: USER_CODE,
				client_metadata: null,
				request_ip: null,
				pending_expires_at: new Date(Date.now() + 60_000),
				denied_at: new Date(),
			},
		]);
		const res = await REQUEST(get(`device_code=${DEVICE_CODE}&user_code=${USER_CODE}`));
		expect((await res.json()).status).toBe("denied");
	});
});

// #3889's display half, at the transport. `clientMetadataField` is unit-tested next door in
// tests/lib/auth/cli-device-consent.test.ts; what is pinned here is that the two routes which
// touch these strings ACTUALLY CALL IT — on the way in, and on the way back out.
//
// Both halves are needed and neither implies the other. `/start` normalises what it stores,
// so nothing unsafe is written from today on; `/request` normalises what it returns, because
// rows written before #4035 are still in the table and the route reads them straight out of a
// JSONB column. A guard that only ran on the write path would be a guard against future rows.
describe("the requester's strings never reach the consent screen unscrubbed", () => {
	// U+202E RIGHT-TO-LEFT OVERRIDE, by name, as an escape. A literal one is invisible in a
	// diff — the same property that makes it worth stripping.
	const RTL_OVERRIDE = "\u202E";

	it("scrubs what /start stores", async () => {
		fake.queue.push([], [], [{ user_code: USER_CODE }]);
		await START(
			post(
				"/api/auth/cli/start",
				{
					device_code: DEVICE_CODE,
					user_code: USER_CODE,
					client_name: `alethia-cli${RTL_OVERRIDE}forged`,
					client_version: "0.42.1\nVerified by Alethia",
				},
				// The user-agent's unsafe value is WHITESPACE PADDING, not a zero-width character.
				// An HTTP header value is a ByteString: `new Request` throws on any code point
				// above 255, so the bidi and zero-width cases can only be carried by the JSON
				// body fields above. Padding is the header-legal member of the same family — it
				// pushes the real value out of view — and it is what this field can test.
				{ "user-agent": `alethia-cli${" ".repeat(120)}(official build)` },
			),
		);

		const insert = fake.ops.find((o) => o.kind === "insert");
		const stored = insert?.values?.client_metadata;
		expect(JSON.stringify(stored)).not.toContain(RTL_OVERRIDE);
		expect(JSON.stringify(stored)).not.toContain("\\n");
		// Collapsed, not merely trimmed: the padding is gone from the MIDDLE of the value.
		expect(stored).toMatchObject({
			user_agent: "alethia-cli (official build)",
		});
	});

	// The half a write-time guard cannot cover: a row already in the table.
	it("scrubs what /request returns for a row written before the guard existed", async () => {
		fake.queue.push([
			{
				profile_id: null,
				user_code: USER_CODE,
				client_metadata: {
					client_name: `alethia-cli${RTL_OVERRIDE}forged`,
					client_version: "0.42.1",
					user_agent: "alethia-cli\nAlethia says: this device is trusted",
				},
				request_ip: "203.0.113.7",
				pending_expires_at: new Date(Date.now() + 60_000),
				denied_at: null,
			},
		]);

		const res = await REQUEST(get(`device_code=${DEVICE_CODE}&user_code=${USER_CODE}`));
		expect(res.status).toBe(200);
		const body = await res.json();

		expect(body.requester.client_name).not.toContain(RTL_OVERRIDE);
		expect(body.requester.user_agent).not.toContain("\n");
		// Scrubbed, not blanked. The value is still the value a person has to judge.
		expect(body.requester.client_name).toContain("alethia-cli");
		expect(body.requester.request_ip).toBe("203.0.113.7");
	});

	// The control. Both assertions above would pass against a route that returned nulls for
	// everything, which would be a worse defect than the one they are guarding.
	it("leaves an honest requester alone", async () => {
		fake.queue.push([
			{
				profile_id: null,
				user_code: USER_CODE,
				client_metadata: {
					client_name: "alethia-cli",
					client_version: "0.42.1",
					user_agent: "alethia-cli/0.42.1 (darwin; arm64)",
				},
				request_ip: "203.0.113.7",
				pending_expires_at: new Date(Date.now() + 60_000),
				denied_at: null,
			},
		]);

		const res = await REQUEST(get(`device_code=${DEVICE_CODE}&user_code=${USER_CODE}`));
		expect((await res.json()).requester).toEqual({
			client_name: "alethia-cli",
			client_version: "0.42.1",
			user_agent: "alethia-cli/0.42.1 (darwin; arm64)",
			request_ip: "203.0.113.7",
		});
	});
});
