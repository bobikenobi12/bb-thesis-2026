// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// SP-initiated SSO entry point: https://<origin>/sso/<org-slug>. The SSO settings page hands this
// URL to the customer's IdP admin (and users bookmark it), but it previously 404'd — nothing served
// it. Resolve the org by slug, pick its provider, and hand off to @better-auth/sso's sign-in.
//
// With several providers, `?provider=<providerId>` (or `?domain=`) selects one; otherwise the sole
// provider is used. Errors redirect to /login rather than leaking whether an org/provider exists.

import { and, eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getServiceDb } from "@/lib/db";
import { organization, ssoProvider } from "@/lib/db/schema";

/** better-auth's sign-in/sso response carries the IdP redirect target. */
const signInResponse = z.object({ url: z.string().url() });

/** Fall back to the normal login page — never reveal whether the org/provider exists. */
function toLogin(req: NextRequest, reason: string): NextResponse {
	const url = new URL("/login", req.nextUrl.origin);
	url.searchParams.set("sso_error", reason);
	return NextResponse.redirect(url);
}

export async function GET(
	req: NextRequest,
	{ params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
	const { slug } = await params;
	const db = getServiceDb();

	const [org] = await db
		.select({ id: organization.id })
		.from(organization)
		.where(eq(organization.slug, slug))
		.limit(1);
	if (!org) return toLogin(req, "unknown_org");

	const wantedProvider = req.nextUrl.searchParams.get("provider");
	const wantedDomain = req.nextUrl.searchParams.get("domain");

	const providers = await db
		.select({
			providerId: ssoProvider.providerId,
			domain: ssoProvider.domain,
		})
		.from(ssoProvider)
		.where(
			wantedProvider
				? and(
						eq(ssoProvider.organizationId, org.id),
						eq(ssoProvider.providerId, wantedProvider),
					)
				: eq(ssoProvider.organizationId, org.id),
		);

	const chosen = wantedDomain
		? providers.find((p) => p.domain === wantedDomain)
		: providers[0];
	if (!chosen) return toLogin(req, "no_provider");

	const callbackURL = req.nextUrl.searchParams.get("next") ?? "/dashboard";

	// Dispatch through auth.handler: the sso() plugin is loaded via the ee/ seam, so `auth.api`
	// can't statically type its endpoints and the open-core guard forbids importing @alethia/ee.
	try {
		const forwardedHeaders = new Headers(req.headers);
		forwardedHeaders.set("content-type", "application/json");
		const res = await auth.handler(
			new Request(`${req.nextUrl.origin}/api/auth/sign-in/sso`, {
				method: "POST",
				headers: forwardedHeaders,
				body: JSON.stringify({
					providerId: chosen.providerId,
					callbackURL,
				}),
			}),
		);
		if (!res.ok) return toLogin(req, "sso_unavailable");
		const parsed = signInResponse.safeParse(await res.json());
		if (!parsed.success) return toLogin(req, "sign_in_unavailable");
		return NextResponse.redirect(parsed.data.url);
	} catch {
		// e.g. the provider's domain isn't verified yet — the plugin rejects sign-in.
		return toLogin(req, "sso_unavailable");
	}
}
