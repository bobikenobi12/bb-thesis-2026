// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// GET /api/cli/schema/components (#3671). Two things are worth proving about the route itself —
// the document's content is pinned in tests/lib/cli/component-schema.test.ts.
//
//   1. It is GATED. "Read-only" and "holds no tenant data" are reasons the response is cheap, not
//      reasons it is public; it is gated exactly like the component list it describes.
//   2. Its conditional-request path is a CACHE, not a shortcut. The 304 must sit BEHIND the
//      authorization check — a revalidation that answers before the gate is an unauthenticated
//      oracle for whether a given schema version exists.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({ authorizeCli: vi.fn() }));

import { GET } from "@/app/api/cli/schema/components/route";
import { authorizeCli } from "@/lib/authz/guard";

const URL_ = "https://console.local/api/cli/schema/components";

function req(headers: Record<string, string> = {}): Request {
	return new Request(URL_, { headers });
}

/** The ETag the route currently serves, read from a fresh 200. */
async function currentEtag(): Promise<string> {
	const res = await GET(req());
	const etag = res.headers.get("ETag");
	if (!etag) throw new Error("the 200 served no ETag — nothing to revalidate against");
	return etag;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(authorizeCli).mockResolvedValue({
		actor: { userId: "user-1", orgId: "org-1" },
	} as never);
});

describe("authorization", () => {
	it("enforces project:view, the same gate as the component list it describes", async () => {
		await GET(req());
		expect(authorizeCli).toHaveBeenCalledWith(expect.any(Request), "view", {
			type: "project",
		});
	});

	it("returns the guard's denial and no document", async () => {
		const denied = new Response(JSON.stringify({ error: "Forbidden" }), {
			status: 403,
		});
		vi.mocked(authorizeCli).mockResolvedValue({ error: denied } as never);

		const res = await GET(req());
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: "Forbidden" });
	});

	// The ordering bug this rules out: a conditional request answered from the ETag before the
	// gate runs would tell an unauthenticated caller which schema version the server holds.
	it("refuses a matching conditional request too — the gate runs first", async () => {
		const etag = await currentEtag();
		vi.mocked(authorizeCli).mockResolvedValue({
			error: new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }),
		} as never);

		const res = await GET(req({ "If-None-Match": etag }));
		expect(res.status).toBe(403);
	});
});

describe("the served document", () => {
	it("serves the kind registry with a content-hash ETag", async () => {
		const res = await GET(req());
		expect(res.status).toBe(200);

		const body = await res.json();
		expect(body.kinds.map((k: { kind: string }) => k.kind)).toContain(
			"helm_registries",
		);
		expect(body.version).toMatch(/^[0-9a-f]{64}$/);
		expect(res.headers.get("ETag")).toBe(`"${body.version}"`);
	});

	// The document is derived from committed code and holds nothing per-tenant, so it must not be
	// stored by a shared cache on the strength of being identical for everyone.
	it("keeps the token-gated response out of shared caches", async () => {
		const res = await GET(req());
		expect(res.headers.get("Cache-Control")).toContain("private");
	});

	// The regression this pins by name: `no-cache` (or `no-store`) means a stored copy must be
	// revalidated with the origin before EVERY reuse, so every `alethia project component …` would
	// spend a round trip while holding a byte-identical document — the cost this endpoint exists to
	// remove. The document cannot change without a deploy, so the held copy is allowed to be used.
	it("lets a client reuse its copy instead of revalidating every command", async () => {
		const res = await GET(req());
		const cacheControl = res.headers.get("Cache-Control") ?? "";
		expect(cacheControl).toBe("private, max-age=300");
		expect(cacheControl).not.toMatch(/no-cache|no-store/);
	});
});

describe("conditional requests", () => {
	it("answers 304 with no body when the client already holds this version", async () => {
		const etag = await currentEtag();
		const res = await GET(req({ "If-None-Match": etag }));

		expect(res.status).toBe(304);
		expect(res.headers.get("ETag")).toBe(etag);
		expect(await res.text()).toBe("");
	});

	it("answers 304 for the weak-validator form", async () => {
		const etag = await currentEtag();
		const res = await GET(req({ "If-None-Match": `W/${etag}` }));
		expect(res.status).toBe(304);
	});

	it("answers 304 for a list that contains the current tag", async () => {
		const etag = await currentEtag();
		const res = await GET(req({ "If-None-Match": `"stale-one", ${etag}` }));
		expect(res.status).toBe(304);
	});

	it("answers 304 for `*`, which names any current representation", async () => {
		const res = await GET(req({ "If-None-Match": "*" }));
		expect(res.status).toBe(304);
	});

	// The branch that makes the 304s meaningful: a stale tag must re-serve the document, or the
	// client would cache the first version it ever saw forever.
	it("re-serves the full document when the held tag is stale", async () => {
		const res = await GET(req({ "If-None-Match": '"0000000000000000"' }));
		expect(res.status).toBe(200);
		expect((await res.json()).kinds.length).toBeGreaterThan(0);
	});

	// Entity tags are compared as whole quoted strings, never by containment. A bare, unquoted hash
	// is the shape a hand-rolled client sends, and a substring comparison would 304 it — the wrong
	// direction to be loose in, because the caller then keeps a document the server never confirmed.
	// Re-serving is the conservative answer and it is the asserted one.
	it("does not match an unquoted tag by containment", async () => {
		const etag = await currentEtag();
		const res = await GET(req({ "If-None-Match": etag.replaceAll('"', "") }));
		expect(res.status).toBe(200);
	});
});
