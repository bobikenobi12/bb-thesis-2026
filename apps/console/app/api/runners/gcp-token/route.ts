// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Internal runner endpoint: mint a short-lived OIDC assertion for keyless GCP provisioning (DIRECT OIDC).
// A managed runner executing a `tofu apply` against a GCP connection whose Workload-Identity pool trusts
// the Alethia issuer directly writes this assertion to a token file that google-auth re-reads to exchange
// for a GCP access token — no AWS hop, no service-account key. The console holds the issuer signing key.

import { GCP_TOKEN_AUDIENCE } from "@/lib/cloud-providers/session/gcp";
import {
	assertionSourceForProvider,
	workloadAssertionSourceConfigured,
} from "@/lib/oidc/assertion-source";
import { authorizeTokenMint } from "@/lib/runners/token-mint-auth";
import { NextResponse } from "next/server";

/** Mints a GCP WIF assertion for a runner, bound to a job it owns. */
export async function POST(req: Request) {
	const { error: authError } = await authorizeTokenMint(req, "gcp");
	if (authError) return authError;

	if (!workloadAssertionSourceConfigured()) {
		return NextResponse.json(
			{ error: "The workload-identity issuer is not configured (ALETHIA_OIDC_SIGNING_KEY)." },
			{ status: 501 },
		);
	}

	try {
		const token = await assertionSourceForProvider("gcp").getAssertion({
			audience: GCP_TOKEN_AUDIENCE,
		});
		return NextResponse.json({ token });
	} catch {
		console.error("GCP token mint failed");
		return NextResponse.json({ error: "Failed to mint GCP token" }, { status: 500 });
	}
}
