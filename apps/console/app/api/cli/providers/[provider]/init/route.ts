// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import * as conn from "@/lib/cloud-providers/connections";
import {
	enforceProviderPermission,
	errorResponse,
	resolveCliProvider,
} from "@/lib/cli/providers";
import { NextResponse } from "next/server";

/** Gets or creates the CLI user's identity for a provider (AWS also returns external_id). */
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

	try {
		const result = await conn.initIdentity(scope, provider);
		return NextResponse.json({
			identity_id: result.identityId,
			external_id: result.externalId ?? null,
		});
	} catch (err) {
		return errorResponse(err, 500);
	}
}
