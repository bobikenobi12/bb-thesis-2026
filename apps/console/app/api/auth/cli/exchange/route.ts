// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, eq, isNotNull, isNull } from "drizzle-orm";
import * as jose from "jose";
import { env } from "next-runtime-env";
import {
	CLI_DEVICE_RATE_LIMIT,
	DEVICE_ACCESS_DENIED,
	deviceCodeFail,
	isDeviceCodeExpired,
	isValidDeviceCode,
} from "@/lib/auth/cli-device-code";
import { cliDeviceRateLimitKey } from "@/lib/auth/trusted-ip";
import { getServiceDb } from "@/lib/db";
import { cliLogins, profiles } from "@/lib/db/schema";
import { checkRateLimit } from "@/lib/rate-limit";
import { NextResponse } from "next/server";

/**
 * Redeems an approved device code for a CLI token pair. Single-use: the row is claimed
 * with an atomic DELETE … RETURNING, so two concurrent polls cannot both mint tokens.
 *
 * Statuses the CLI depends on: 404 = still pending (keep polling), 410 = expired or
 * already redeemed (terminal), 429 = throttled (back off and keep polling).
 */
export async function POST(req: Request) {
	// 1. The JWT secret gates everything, so check it FIRST. Doing it after the DB work
	// consumed the single-use row and then 500'd, leaving the user with a dead code and
	// no explanation.
	const jwtSecret = env("CLI_JWT_SECRET");
	if (!jwtSecret) {
		console.error("CLI_JWT_SECRET is not set in environment variables.");
		return deviceCodeFail("Internal server configuration error", 500);
	}

	const limitKey = cliDeviceRateLimitKey("exchange", req.headers);
	if (
		limitKey &&
		!checkRateLimit(
			limitKey,
			CLI_DEVICE_RATE_LIMIT.limit,
			CLI_DEVICE_RATE_LIMIT.windowMs,
		).ok
	) {
		return deviceCodeFail("Too many requests", 429);
	}

	const body = await req.json().catch(() => null);
	const device_code = body?.device_code;

	if (!isValidDeviceCode(device_code)) {
		return deviceCodeFail("Missing or malformed device_code", 400);
	}

	const db = getServiceDb();

	// 2. Claim the approved login record atomically. The previous select-then-delete let
	// two concurrent POSTs both read the row and BOTH mint a full token pair; a DELETE …
	// RETURNING can only succeed once.
	//
	// The predicate is narrowed to APPROVED, UNREFUSED rows, and both halves are load-
	// bearing now that a row can exist before anybody has pressed anything:
	//
	//   profile_id IS NOT NULL — a pending registration is what the consent screen renders
	//   from. An unnarrowed DELETE would remove it on the CLI's very first poll, two seconds
	//   after the browser opened, and the screen would lose its contents mid-decision.
	//   denied_at IS NULL — a refusal has to SURVIVE being polled, or the terminal would see
	//   it once and every later poll would read as "pending" again.
	const [claimed] = await db
		.delete(cliLogins)
		.where(
			and(
				eq(cliLogins.device_code, device_code),
				isNotNull(cliLogins.profile_id),
				isNull(cliLogins.denied_at),
			),
		)
		.returning({
			profile_id: cliLogins.profile_id,
			verification_code: cliLogins.verification_code,
			expires_at: cliLogins.expires_at,
			created_at: cliLogins.created_at,
		});

	if (!claimed?.profile_id) {
		// Nothing was claimable, and that is TWO different answers: "still pending" or "the
		// user refused". RFC 8628 §3.5 makes `access_denied` terminal, so the CLI can stop
		// instead of spinning to its own ten-minute timeout while the person who pressed
		// "This isn't me" believes their refusal did something.
		const [state] = await db
			.select({ denied_at: cliLogins.denied_at })
			.from(cliLogins)
			.where(eq(cliLogins.device_code, device_code))
			.limit(1);

		if (state?.denied_at) {
			return deviceCodeFail(
				DEVICE_ACCESS_DENIED,
				403,
				"The sign-in was refused in the browser.",
			);
		}
		return deviceCodeFail("Authentication pending or not found", 404);
	}

	// 3. An expired code is unusable — and already consumed above. 410 (not 404), because
	// the CLI treats 404 as "still pending" and would spin on it forever.
	if (isDeviceCodeExpired(claimed)) {
		return deviceCodeFail("This device code has expired — run `alethia login` again", 410);
	}

	// A DELETE … RETURNING cannot join, so resolve the email in its own query.
	const [profile] = await db
		.select({ email: profiles.email })
		.from(profiles)
		.where(eq(profiles.id, claimed.profile_id))
		.limit(1);

	// 4. Create a new custom JWT for the CLI
	const secret = new TextEncoder().encode(jwtSecret);
	const alg = "HS256";

	const accessToken = await new jose.SignJWT({
		sub: claimed.profile_id,
		email: profile?.email,
		type: "access",
	})
		.setProtectedHeader({ alg })
		.setIssuedAt()
		.setIssuer("urn:example:issuer")
		.setAudience("urn:example:audience")
		.setExpirationTime("1h")
		.sign(secret);

	const refreshToken = await new jose.SignJWT({
		sub: claimed.profile_id,
		email: profile?.email,
		type: "refresh",
	})
		.setProtectedHeader({ alg })
		.setIssuedAt()
		.setIssuer("urn:example:issuer")
		.setAudience("urn:example:audience")
		.setExpirationTime("90d")
		.sign(secret);

	return NextResponse.json({
		access_token: accessToken,
		refresh_token: refreshToken,
		provider_token: claimed.verification_code,
		user_email: profile?.email ?? null,
	});
}
