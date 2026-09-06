// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Internal runner endpoint: mint a short-lived OIDC assertion for keyless AWS provisioning. A managed
// runner executing a `tofu apply` against AWS has NO ambient AWS identity (the Hetzner fleet injects no
// keys). It calls this route with its runner credentials and gets a freshly-minted assertion (audience
// sts.amazonaws.com, subject alethia-connector). The runner exchanges it DIRECTLY for the customer's
// provisioner role via AssumeRoleWithWebIdentity — the customer's IAM role trusts the Alethia issuer, so
// there is no platform AWS account in the path. The assertion goes into a web-identity token file the AWS
// SDK re-reads + auto-refreshes. No access key ever reaches the runner; the console alone holds the signing
// key.

import { AWS_TOKEN_AUDIENCE, awsConfigured } from "@/lib/cloud-providers/session/aws";
import { assertionSourceForProvider } from "@/lib/oidc/assertion-source";
import { authorizeTokenMint } from "@/lib/runners/token-mint-auth";
import { NextResponse } from "next/server";

/** Mints an AWS web-identity assertion for a runner, bound to a job it owns. */
export async function POST(req: Request) {
	const { error: authError } = await authorizeTokenMint(req, "aws");
	if (authError) return authError;

	if (!awsConfigured()) {
		return NextResponse.json(
			{ error: "The workload-identity issuer is not configured (ALETHIA_OIDC_SIGNING_KEY)." },
			{ status: 501 },
		);
	}

	try {
		const token = await assertionSourceForProvider("aws").getAssertion({
			audience: AWS_TOKEN_AUDIENCE,
		});
		return NextResponse.json({
			token,
			// STS is global, but the SDK wants a region; fall back to us-east-1.
			region: process.env.AWS_REGION || "us-east-1",
		});
	} catch {
		console.error("AWS token mint failed");
		return NextResponse.json({ error: "Failed to mint AWS token" }, { status: 500 });
	}
}
