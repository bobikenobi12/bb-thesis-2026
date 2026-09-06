// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #4133's silent half. `currentActor()` takes the tenant from the address, and it learns the
// address from a header `proxy.ts` publishes. If the proxy stops setting it — a refactor, a
// narrowed matcher, an early `return` added above it — there is no error and no red test
// elsewhere: `urlScopedOrgId` reads null, every reader falls back to `active_organization_id`, and
// the console is silently back on the session it used to trust. That is the defect wearing a pass.
//
// So the publication is asserted here, on its own, including on the branches that return early.

import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import { ORG_PATH_HEADER } from "@/lib/authz/org-path";

const at = (url: string, headers?: HeadersInit) =>
	new NextRequest(new Request(`https://console.example.invalid${url}`, { headers }));

/**
 * What the proxy forwarded to the app. Next carries an overridden request header on the RESPONSE
 * as `x-middleware-request-<name>`, and names it in `x-middleware-override-headers` — the second is
 * what makes the first apply, so both are asserted.
 */
async function published(res: Promise<Response>): Promise<string | null> {
	const r = await res;
	const overridden = (r.headers.get("x-middleware-override-headers") ?? "").split(",");
	if (!overridden.includes(ORG_PATH_HEADER)) return null;
	return r.headers.get(`x-middleware-request-${ORG_PATH_HEADER}`);
}

describe("the proxy publishes the request path", () => {
	it("on an org-scoped route, which is the one that decides the tenant", async () => {
		await expect(published(proxy(at("/acme/hero-app/environments")))).resolves.toBe(
			"/acme/hero-app/environments",
		);
	});

	it("...on the personal segment too", async () => {
		await expect(published(proxy(at("/~/evidence")))).resolves.toBe("/~/evidence");
	});

	it("...and on a route with no org in it at all", async () => {
		await expect(published(proxy(at("/login")))).resolves.toBe("/login");
	});

	// THE TWO BRANCHES THAT PUBLISH NOTHING, pinned so they stay the only two. Both RETURN a
	// redirect, so no app code runs on them and no reader is left resolving a tenant from a
	// session — the header's absence there costs nothing. A third early return added above the
	// publication would be a silent regression, and it would land here as a change to this list.
	it("except on a redirect, where no reader runs — the sign-in bounce", async () => {
		await expect(published(proxy(at("/dashboard")))).resolves.toBeNull();
	});

	it("...and the /auth/signin → /login back-compat redirect", async () => {
		await expect(published(proxy(at("/auth/signin")))).resolves.toBeNull();
	});

	// THE ANTI-FORGERY PROPERTY. `currentActor()` trusts this header completely, so a client that
	// sends its own must not be believed. `Headers.set` replaces rather than appends; this pins it,
	// because the difference between `set` and `append` here is the difference between a header the
	// proxy owns and a tenancy selector any browser can type.
	it("...REPLACING a value the client tried to send, never merging with it", async () => {
		const res = proxy(at("/acme/hero-app", { [ORG_PATH_HEADER]: "/victim-org/secrets" }));
		await expect(published(res)).resolves.toBe("/acme/hero-app");
	});
});
