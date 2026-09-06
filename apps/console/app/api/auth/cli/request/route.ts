// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import {
	CLI_DEVICE_RATE_LIMIT,
	checkDeviceCodeBinding,
	checkUserCodeBinding,
	clientMetadataField,
	deviceApprovalScopes,
	deviceCodeFail,
	deviceRequestStatus,
	isCliGitProvider,
	isPendingRequestExpired,
	isValidDeviceCode,
	isValidUserCode,
	type CliDeviceRequestView,
	type CliGitProvider,
} from "@/lib/auth/cli-device-code";
import { cliDeviceRateLimitKey } from "@/lib/auth/trusted-ip";
import { getServiceDb } from "@/lib/db";
import { cliLogins } from "@/lib/db/schema";
import { checkRateLimit } from "@/lib/rate-limit";
import { NextResponse } from "next/server";

/**
 * Reads one pending CLI device request so `/cli/login` can name what is being consented to.
 *
 * The consent screen showed a `user_code` and two buttons. It did not say which account was
 * about to be bound, what approval hands over, who was asking, or how long the request had
 * left — and RFC 8628's threat model is a phished link, so the requester fields are exactly
 * the ones that make a phish visible.
 *
 * Session-gated: it returns the signed-in account's identity and the requester's IP, and
 * neither is anybody else's to read. It is also the reason the whole view is worth trusting
 * — every field below comes from the registration the CLI made at `/api/auth/cli/start`,
 * not from the query string, so nothing on the screen is under the sender's control except
 * the codes, which must match what was registered.
 */
export async function GET(req: Request) {
	const hdrs = await headers();

	const limitKey = cliDeviceRateLimitKey("request", hdrs);
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

	const url = new URL(req.url);
	const device_code = url.searchParams.get("device_code");
	const user_code = url.searchParams.get("user_code");
	if (!isValidDeviceCode(device_code)) {
		return deviceCodeFail("Missing or malformed device_code", 400);
	}
	if (!isValidUserCode(user_code)) {
		return deviceCodeFail("Missing or malformed user_code", 400);
	}

	const db = getServiceDb();

	const [row] = await db
		.select({
			profile_id: cliLogins.profile_id,
			user_code: cliLogins.user_code,
			client_metadata: cliLogins.client_metadata,
			request_ip: cliLogins.request_ip,
			pending_expires_at: cliLogins.pending_expires_at,
			denied_at: cliLogins.denied_at,
		})
		.from(cliLogins)
		.where(eq(cliLogins.device_code, device_code))
		.limit(1);

	// 404, not an empty view. A CLI too old to register leaves no row, and the page has to
	// be able to tell "this request carries no server-verified detail" from "it carries
	// detail and the detail is blank" — the second would render a consent screen whose empty
	// fields look like answers.
	if (!row) {
		return deviceCodeFail("No such login request", 404);
	}

	// The same takeover gate `/generate` applies, applied BEFORE anything is returned: a
	// request already bound to another account is not this session's to inspect.
	if (!checkDeviceCodeBinding(row, session.user.id).ok) {
		return deviceCodeFail("This login request belongs to another account", 409);
	}

	// Fail closed on a code that disagrees with the registered one. Returning the view
	// anyway would put the REGISTERED requester's details behind a code the user was shown a
	// different version of — the precise confusion the binding exists to prevent.
	if (!checkUserCodeBinding(row, user_code).ok) {
		return deviceCodeFail("This login request does not match that code", 409);
	}

	let gitProvider: CliGitProvider | null = null;
	try {
		const accounts = await auth.api.listUserAccounts({ headers: hdrs });
		// A loop rather than `find`, because `find`'s predicate narrows the ELEMENT and not
		// the field this needs: `git.providerId` would still be a bare `string` afterwards
		// and would need a cast to become one of the three. Here the guard narrows the value
		// itself, so the union is reached without asserting anything.
		for (const account of accounts) {
			if (isCliGitProvider(account.providerId)) {
				gitProvider = account.providerId;
				break;
			}
		}
	} catch {
		// No linked provider readable — the scope list simply omits the git line, which is
		// the same thing `/generate` will do when it cannot resolve a token.
	}

	const lifecycle = deviceRequestStatus(row);
	const view: CliDeviceRequestView = {
		status:
			lifecycle === "pending" && isPendingRequestExpired(row)
				? "expired"
				: lifecycle,
		// The REGISTERED code, never the one from the query string. They are equal by the
		// check above wherever one was registered; returning the stored value is what makes
		// this field's meaning "what the terminal printed" rather than "what the link said".
		user_code: row.user_code ?? user_code,
		account: {
			email: session.user.email ?? null,
			name: session.user.name ?? null,
		},
		// Re-normalised on the way OUT, not just on the way in. `/api/auth/cli/start` runs
		// `clientMetadataField` over these before storing them, so for anything registered
		// since #4035 this is a no-op — but the column is JSONB written by an unauthenticated
		// route, rows predating that normalisation are still in the table, and this response
		// is the consent screen's whole description of who is asking. A newline or a bidi
		// override reaching it would let the requester write a line the reader reads as the
		// server's. `request_ip` goes through it too: it is server-DERIVED, but it is derived
		// from a header, and the same bound costs nothing.
		requester: {
			client_name: clientMetadataField(row.client_metadata?.client_name),
			client_version: clientMetadataField(row.client_metadata?.client_version),
			user_agent: clientMetadataField(row.client_metadata?.user_agent),
			request_ip: clientMetadataField(row.request_ip),
		},
		scopes: deviceApprovalScopes(gitProvider),
		expires_at: row.pending_expires_at?.toISOString() ?? null,
	};

	return NextResponse.json(view, {
		// The view carries the signed-in account's email and the requester's IP, and its
		// countdown is only correct at the instant it was computed.
		headers: { "cache-control": "no-store" },
	});
}
