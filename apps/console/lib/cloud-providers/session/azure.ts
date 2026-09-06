// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Azure session — KEYLESS, customer-side. The customer creates a User-Assigned Managed Identity in
// their own subscription with a federated-identity credential trusting the Alethia OIDC issuer
// (lib/oidc/issuer.ts). The console authenticates AS that identity against the CUSTOMER's tenant by
// presenting a freshly-minted assertion — no client secret, and NO platform Entra app. The identity's
// client id is stored per-connection (credentials.client_id), so a self-hosted console needs only the
// issuer configured (parity with AWS/GCP), not an `ALETHIA_AZURE_CLIENT_ID`.

import { ClientAssertionCredential } from "@azure/identity";
import {
	assertionSourceForProvider,
	workloadAssertionSourceConfigured,
} from "@/lib/oidc/assertion-source";

/** The audience Azure AD expects for a federated-credential token exchange. */
export const AZURE_TOKEN_AUDIENCE = "api://AzureADTokenExchange";

/**
 * Builds a keyless credential for the customer tenant: the customer identity's client id + a minted
 * OIDC assertion as the client assertion. Authenticates against `tenantId` (the CUSTOMER tenant stored
 * on the identity). `clientId` is the customer's managed-identity application id (credentials.client_id),
 * not a platform app. Throws if the client id is missing or the issuer isn't configured.
 */
export function assumeAzureIdentity(
	tenantId: string,
	clientId: string,
): ClientAssertionCredential {
	if (!clientId) {
		throw new Error("This Azure connection has no client id (managed-identity application id).");
	}
	if (!workloadAssertionSourceConfigured()) {
		throw new Error("The workload-identity issuer is not configured (ALETHIA_OIDC_SIGNING_KEY).");
	}
	return new ClientAssertionCredential(tenantId, clientId, () =>
		assertionSourceForProvider("azure").getAssertion({
			audience: AZURE_TOKEN_AUDIENCE,
		}),
	);
}
