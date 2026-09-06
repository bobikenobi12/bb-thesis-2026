// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import {
	CLI_DEVICE_RATE_LIMIT,
	checkDeviceCodeBinding,
	checkUserCodeBinding,
	deviceCodeFail,
	isValidDeviceCode,
	isValidUserCode,
} from "@/lib/auth/cli-device-code";
import { cliDeviceRateLimitKey } from "@/lib/auth/trusted-ip";
import { getServiceDb } from "@/lib/db";
import { cliLogins } from "@/lib/db/schema";
import { checkRateLimit } from "@/lib/rate-limit";
import { NextResponse } from "next/server";

/**
 * Records a refusal of one CLI device request — the server half of "This isn't me".
 *
 * Before this route that button set `setStage("declined")` and nothing else. Two things
 * followed from that. The polling CLI never learned it had been refused and span until its
 * own ten-minute timeout, so the person who just said "this isn't me" gave the terminal — in
 * the phishing case, the ATTACKER's terminal — no signal at all. And the refusal was not
 * durable: it lived in React state, so re-opening the same link presented the approval
 * prompt again and a "click it again, it glitched" follow-up undid it.
 *
 * Session-gated and rate-limited exactly like `/generate`, and that is not symmetry for its
 * own sake. An unauthenticated deny endpoint is a cheap denial of service on `alethia login`:
 * anyone able to reach it could terminate somebody else's in-flight sign-in.
 */
export async function POST(req: Request) {
	const hdrs = await headers();

	const limitKey = cliDeviceRateLimitKey("deny", hdrs);
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

	const session = await auth.api.getSession({ headers: hdrs });
	if (!session) {
		return deviceCodeFail("Unauthorized", 401);
	}

	const body = await req.json().catch(() => null);
	const device_code = body?.device_code;
	const user_code = body?.user_code;
	if (!isValidDeviceCode(device_code)) {
		return deviceCodeFail("Missing or malformed device_code", 400);
	}
	if (!isValidUserCode(user_code)) {
		return deviceCodeFail("Missing or malformed user_code", 400);
	}

	const db = getServiceDb();

	const [existing] = await db
		.select({
			profile_id: cliLogins.profile_id,
			user_code: cliLogins.user_code,
		})
		.from(cliLogins)
		.where(eq(cliLogins.device_code, device_code))
		.limit(1);

	// The same takeover gate `/generate` applies. Denying is destructive to somebody's
	// login, so a code that already belongs to another account is not yours to refuse — and
	// without this check the endpoint would hand every signed-in user a way to kill any
	// other account's approved-but-unredeemed sign-in.
	if (!checkDeviceCodeBinding(existing, session.user.id).ok) {
		return deviceCodeFail("This login request belongs to another account", 409);
	}

	// A registered request must be refused with the code it registered. A mismatch means the
	// link in this browser and the process at that terminal are not the same login, and
	// acting on it would deny a request the user never saw.
	if (!checkUserCodeBinding(existing, user_code).ok) {
		return deviceCodeFail("This login request does not match that code", 409);
	}

	const deniedAt = new Date();
	// The denial is a ROW, not the absence of one: "no row" already means "not approved
	// yet", which is exactly the state a refusal has to be distinguishable from.
	//
	// profile_id and verification_code are cleared in the same write, so a refusal that
	// arrives AFTER an approval revokes it — the stashed git-provider token stops being
	// redeemable — rather than leaving a row that reads as both approved and denied.
	// `checkDeviceCodeBinding` keeps working across this because it reads profile_id, and a
	// denied row's profile_id is NULL: the row is unowned, which is what it now is.
	try {
		await db
			.insert(cliLogins)
			.values({
				device_code,
				user_code,
				denied_at: deniedAt,
			})
			.onConflictDoUpdate({
				target: cliLogins.device_code,
				set: {
					denied_at: deniedAt,
					profile_id: null,
					verification_code: null,
					refresh_token: null,
				},
			});
	} catch (err) {
		console.error("Error recording CLI login denial:", err);
		return deviceCodeFail("Failed to record the refusal", 500);
	}

	// Confirm the marker is really on the row before telling the browser the refusal was
	// recorded. The screen says "the refusal was recorded"; a write that silently did
	// nothing would make that sentence a lie in exactly the case it matters.
	const [denied] = await db
		.select({ denied_at: cliLogins.denied_at })
		.from(cliLogins)
		.where(eq(cliLogins.device_code, device_code))
		.limit(1);

	if (!denied?.denied_at) {
		return deviceCodeFail("Failed to record the refusal", 500);
	}

	return NextResponse.json({ success: true, denied: true });
}
