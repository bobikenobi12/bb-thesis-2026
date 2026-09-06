// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, eq, isNull, or } from "drizzle-orm";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import {
	CLI_DEVICE_RATE_LIMIT,
	checkDeviceCodeBinding,
	checkUserCodeBinding,
	deviceCodeExpiresAt,
	deviceCodeFail,
	isCliGitProvider,
	isValidDeviceCode,
	isValidUserCode,
} from "@/lib/auth/cli-device-code";
import { cliDeviceRateLimitKey } from "@/lib/auth/trusted-ip";
import { getServiceDb } from "@/lib/db";
import { cliLogins } from "@/lib/db/schema";
import { checkRateLimit } from "@/lib/rate-limit";
import { NextResponse } from "next/server";

/**
 * Approves one CLI device code for the signed-in user. Called by /cli/login ONLY from an
 * explicit "Approve" press — never on page mount — after the user has compared the
 * `user_code` on screen with the one their terminal printed.
 */
export async function POST(req: Request) {
	const hdrs = await headers();

	const limitKey = cliDeviceRateLimitKey("generate", hdrs);
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
	// RFC 8628 binding: the CLI mints a user_code, prints it, and puts it in the link.
	// A request without one cannot have been shown to the user for comparison.
	if (!isValidUserCode(user_code)) {
		return deviceCodeFail("Missing or malformed user_code", 400);
	}

	const db = getServiceDb();

	// Refuse a device code that already belongs to somebody else instead of silently
	// re-pointing it (see checkDeviceCodeBinding — this is the takeover gate).
	const [existing] = await db
		.select({
			profile_id: cliLogins.profile_id,
			user_code: cliLogins.user_code,
			denied_at: cliLogins.denied_at,
		})
		.from(cliLogins)
		.where(eq(cliLogins.device_code, device_code))
		.limit(1);

	if (!checkDeviceCodeBinding(existing, session.user.id).ok) {
		return deviceCodeFail("This login request belongs to another account", 409);
	}

	// A refusal is TERMINAL. Without this, "This isn't me" would be undoable by re-opening
	// the same link and pressing Approve, which is exactly what a "click it again, it
	// glitched" follow-up asks for and the reason the refusal had to become durable at all.
	if (existing?.denied_at) {
		return deviceCodeFail(
			"This login request was refused. Run `alethia login` again.",
			409,
		);
	}

	// The user_code the CLI REGISTERED is the one that must be presented. Before it was
	// persisted this route checked the value's shape and never compared it against
	// anything, so the code on the consent screen carried no server-verified meaning. A
	// mismatch is refused rather than coerced: it means the browser and the terminal are
	// not looking at the same login. A request with nothing registered still passes — see
	// checkUserCodeBinding for why that arm is permissive.
	if (!checkUserCodeBinding(existing, user_code).ok) {
		return deviceCodeFail("This login request does not match that code", 409);
	}

	// Best-effort: stash the user's first linked git provider token for the CLI
	// (temporarily held in verification_code, during the device-code flow).
	let providerToken: string | null = null;
	try {
		const accounts = await auth.api.listUserAccounts({ headers: hdrs });
		const git = accounts.find((a) => isCliGitProvider(a.providerId));
		if (git) {
			// 1.7's selector is the LOCAL account.id. This site needs no extra lookup: the
			// listUserAccounts row already carries `id`, which is exactly that value.
			const at = await auth.api.getAccessToken({
				body: { accountId: git.id, userId: session.user.id },
				headers: hdrs,
			});
			providerToken = at.accessToken ?? null;
		}
	} catch {
		// No linked git provider / token unavailable — proceed without one.
	}

	// expires_at goes into BOTH values and the conflict update: writing it only on insert
	// would leave a returning user re-approving the same code on their original (stale)
	// deadline, and their login would fail.
	const expiresAt = deviceCodeExpiresAt();
	const values = {
		device_code,
		profile_id: session.user.id,
		verification_code: providerToken,
		expires_at: expiresAt,
		// Written on BOTH paths so a row that reaches approval without a registration — an
		// older CLI, which never calls /api/auth/cli/start — still ends up carrying the code
		// it was approved with. Otherwise the binding check above stays vacuous for that
		// row's whole life and a second, different code could approve it.
		user_code,
	};

	try {
		await db
			.insert(cliLogins)
			.values(values)
			.onConflictDoUpdate({
				target: cliLogins.device_code,
				set: {
					profile_id: values.profile_id,
					verification_code: values.verification_code,
					expires_at: values.expires_at,
					user_code: values.user_code,
				},
				// Closes the race between the SELECT above and this write: only an unowned,
				// UNREFUSED row, or one already ours, may be re-bound. The denied_at clause
				// is what stops a refusal that lands between that SELECT and this write from
				// being silently overwritten by the approval it was racing.
				setWhere: and(
					isNull(cliLogins.denied_at),
					or(
						isNull(cliLogins.profile_id),
						eq(cliLogins.profile_id, session.user.id),
					),
				),
			});
	} catch (err) {
		console.error("Error saving CLI login attempt:", err);
		return deviceCodeFail("Failed to save login attempt", 500);
	}

	// The conflict update is a no-op when setWhere does not match, so confirm the row
	// really is ours — and still unrefused — before telling the browser the device is
	// approved.
	const [bound] = await db
		.select({ profile_id: cliLogins.profile_id })
		.from(cliLogins)
		.where(
			and(
				eq(cliLogins.device_code, device_code),
				eq(cliLogins.profile_id, session.user.id),
				isNull(cliLogins.denied_at),
			),
		)
		.limit(1);

	if (!bound) {
		return deviceCodeFail("This login request belongs to another account", 409);
	}

	return NextResponse.json({ success: true });
}
