// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import * as conn from "@/lib/cloud-providers/connections";
import {
	enforceProviderPermission,
	errorResponse,
	resolveCliProvider,
} from "@/lib/cli/providers";
import { NextResponse } from "next/server";

type VerifyBody = { identity_id?: string };

/** Re-verifies a saved cloud identity server-side (auth + provisioning-capability probe). */
export async function POST(
	req: Request,
	{ params }: { params: Promise<{ provider: string }> },
) {
	const { scope, errorResponse: authError } = await resolveCliProvider(
		req,
		params,
	);
	if (authError) return authError;

	const forbid = await enforceProviderPermission(scope, "manage_identities", {
		type: "cloud_identity",
	});
	if (forbid) return forbid;

	let body: VerifyBody;
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
		const result = await conn.reverifyConnection(scope, body.identity_id);
		// Emit the snake_case wire the CLI decodes (matches the /connect route +
		// the Go ConnectIdentityResponse), not the camelCase ConnectionResult.
		return NextResponse.json({
			identity_id: result.identityId,
			verified: result.verified,
			status: result.status,
			error: result.error,
			missing_permissions: result.missingPermissions,
		});
	} catch (err) {
		return errorResponse(err, 400);
	}
}
