// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Internal runner endpoint: mint a short-lived OIDC assertion for keyless Alibaba provisioning. A runner
// executing a `tofu apply` against Alibaba authenticates KEYLESSLY — the alicloud provider does an
// anonymous AssumeRoleWithOIDC using this assertion (audience sts.aliyuncs.com, subject alethia-connector)
// via a token file, so there is NO AccessKey on the runner (the retired platform RAM key). The console is
// the only holder of the issuer signing key.

import { ALIBABA_TOKEN_AUDIENCE } from "@/lib/cloud-providers/session/alibaba";
import {
	assertionSourceForProvider,
	workloadAssertionSourceConfigured,
} from "@/lib/oidc/assertion-source";
import { authorizeTokenMint } from "@/lib/runners/token-mint-auth";
import { NextResponse } from "next/server";

/** Mints an Alibaba AssumeRoleWithOIDC assertion for a runner, bound to a job it owns. */
export async function POST(req: Request) {
	const { error: authError } = await authorizeTokenMint(req, "alibaba");
	if (authError) return authError;

	if (!workloadAssertionSourceConfigured()) {
		return NextResponse.json(
			{ error: "The workload-identity issuer is not configured (ALETHIA_OIDC_SIGNING_KEY)." },
			{ status: 501 },
		);
	}

	try {
		const token = await assertionSourceForProvider("alibaba").getAssertion({
			audience: ALIBABA_TOKEN_AUDIENCE,
		});
		return NextResponse.json({ token });
	} catch {
		console.error("Alibaba token mint failed");
		return NextResponse.json({ error: "Failed to mint Alibaba token" }, { status: 500 });
	}
}
