// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { IdentityPoolClient } from "google-auth-library";
import { assertionSourceForProvider } from "@/lib/oidc/assertion-source";
import type { WifCredentialConfig } from "@/types/jsonb.types";

/**
 * The fixed audience the customer's GCP OIDC provider pins as its `allowed_audiences`, so a minted
 * assertion is scoped to GCP (mirrors AZURE_TOKEN_AUDIENCE / ALIBABA_TOKEN_AUDIENCE). MUST equal
 * ALETHIA_GCP_AUDIENCE in the connector setup script (gcp-setup.sh) or the token exchange is rejected.
 */
export const GCP_TOKEN_AUDIENCE = "alethia-gcp-wif";

/**
 * The `subject_token_type` of a direct-OIDC WIF config — a short-lived JWT minted by the Alethia issuer.
 * (The legacy AWS-hub `aws4_request` federation has been retired; a non-OIDC config now yields no client.)
 */
export const GCP_JWT_SUBJECT_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:jwt";

/** True when the stored WIF config federates directly from the Alethia OIDC issuer. */
export function isOidcWif(wif: WifCredentialConfig | null | undefined): boolean {
	return wif?.subject_token_type === GCP_JWT_SUBJECT_TOKEN_TYPE;
}

/**
 * Builds a google-auth client from a connection's stored WIF config. GCP is KEYLESS via direct OIDC: we
 * supply the subject token programmatically — a freshly minted Alethia assertion — so no AWS source
 * credential is needed; google-auth exchanges it for a GCP token and refreshes by calling the supplier
 * again. Returns `null` for a retired AWS-hub config (the caller reports "reconnect").
 */
export function externalAccountClientFromWif(wif: WifCredentialConfig) {
	if (!isOidcWif(wif)) return null;
	return new IdentityPoolClient({
		audience: wif.audience ?? "",
		subject_token_type: wif.subject_token_type ?? GCP_JWT_SUBJECT_TOKEN_TYPE,
		token_url: wif.token_url ?? "https://sts.googleapis.com/v1/token",
		service_account_impersonation_url: wif.service_account_impersonation_url,
		subject_token_supplier: {
			getSubjectToken: () =>
				assertionSourceForProvider("gcp").getAssertion({
					audience: GCP_TOKEN_AUDIENCE,
				}),
		},
	});
}
