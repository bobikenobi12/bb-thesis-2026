// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import * as conn from "@/lib/cloud-providers/connections";
import {
	enforceProviderPermission,
	errorResponse,
	resolveCliProvider,
} from "@/lib/cli/providers";
import { NextResponse } from "next/server";

type DisconnectBody = { identity_id?: string };

/** Resets a provider identity to its pending state and orphans its projects. */
export async function POST(
	req: Request,
	{ params }: { params: Promise<{ provider: string }> },
) {
	const { scope, provider, errorResponse: authError } =
		await resolveCliProvider(req, params);
	if (authError) return authError;

	const forbid = await enforceProviderPermission(scope, "manage_identities", {
		type: "cloud_identity",
	});
	if (forbid) return forbid;

	let body: DisconnectBody;
	try {
		body = await req.json();
	} catch {
		return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
	}

	if (!body.identity_id) {
		return NextResponse.json(
			{ error: "Missing identity_id" },
			{ status: 400 },
		);
	}

	try {
		const result = await conn.disconnectIdentity(
			scope,
			body.identity_id,
			provider,
		);
		return NextResponse.json(result);
	} catch (err) {
		return errorResponse(err, 400);
	}
}
