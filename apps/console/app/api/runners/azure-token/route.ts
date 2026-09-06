// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Internal runner endpoint: mint a short-lived OIDC assertion for Azure provisioning. A runner
// executing a `tofu apply` against Azure authenticates KEYLESSLY as the CUSTOMER's user-assigned
// managed identity (no platform Entra app) — it calls this route with its runner credentials, gets a
// freshly-minted assertion (audience api://AzureADTokenExchange, subject alethia-connector) that the
// customer identity's federated credential trusts, and hands it to OpenTofu's azurerm provider via
// ARM_OIDC_TOKEN. No client secret ever reaches the runner. The console is the only holder of the
// issuer signing key; the runner just fetches tokens over its authed channel.

import { AZURE_TOKEN_AUDIENCE } from "@/lib/cloud-providers/session/azure";
import {
	assertionSourceForProvider,
	workloadAssertionSourceConfigured,
} from "@/lib/oidc/assertion-source";
import { authorizeTokenMint } from "@/lib/runners/token-mint-auth";
import { NextResponse } from "next/server";

/** Mints an Azure federation assertion for a runner, bound to a job it owns. */
export async function POST(req: Request) {
	const { error: authError } = await authorizeTokenMint(req, "azure");
	if (authError) return authError;

	if (!workloadAssertionSourceConfigured()) {
		return NextResponse.json(
			{ error: "The workload-identity issuer is not configured (ALETHIA_OIDC_SIGNING_KEY)." },
			{ status: 501 },
		);
	}

	try {
		const token = await assertionSourceForProvider("azure").getAssertion({
			audience: AZURE_TOKEN_AUDIENCE,
		});
		return NextResponse.json({ token });
	} catch {
		console.error("Azure token mint failed");
		return NextResponse.json({ error: "Failed to mint Azure token" }, { status: 500 });
	}
}
