// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import * as conn from "@/lib/cloud-providers/connections";
import {
	enforceProviderPermission,
	errorResponse,
	resolveCliProvider,
} from "@/lib/cli/providers";
import { NextResponse } from "next/server";
import { cliJson } from "@/lib/cli/respond";
import { providerStatusWire } from "@/lib/validations/cli-contract";

/** Returns the verified connection status for a provider. */
export async function GET(
	req: Request,
	{ params }: { params: Promise<{ provider: string }> },
) {
	const { scope, provider, errorResponse: authError } =
		await resolveCliProvider(req, params);
	if (authError) return authError;

	const forbid = await enforceProviderPermission(scope, "view", {
		type: "cloud_identity",
	});
	if (forbid) return forbid;

	try {
		const status = await conn.getStatus(scope, provider);
		return cliJson(providerStatusWire, status);
	} catch (err) {
		return errorResponse(err, 500);
	}
}
