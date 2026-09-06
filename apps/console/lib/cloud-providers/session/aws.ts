// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// AWS session — KEYLESS and issuer-direct (the server-side equivalent of the runner's `aws_credentials.go`).
// The customer's IAM role trusts Alethia's OIDC issuer directly (an IAM OIDC provider), so the console
// federates straight into it via STS `AssumeRoleWithWebIdentity`, presenting a short-lived assertion minted
// by the issuer (lib/oidc/issuer.ts) — no platform AWS account, no ExternalId, no stored customer secret
// (the role ARN is metadata). The resulting short-lived session backs the health probe + the asset
// inventory sync, so a connection test needs no runner. Every managed cloud now federates the same way.

import { STSClient, AssumeRoleWithWebIdentityCommand } from "@aws-sdk/client-sts";
import {
	assertionSourceForProvider,
	workloadAssertionSourceConfigured,
} from "@/lib/oidc/assertion-source";
import type { CloudIdentity } from "@/lib/db/schema";

/** Short-lived AWS credentials + the region they were minted for. */
export interface AwsSession {
	credentials: {
		accessKeyId: string;
		secretAccessKey: string;
		sessionToken: string;
	};
	/** The account id we authenticated into (proof of access; from the role ARN). */
	accountId: string | null;
	region: string;
}

/** Per-call network timeout so a hung cloud API never ties up a console worker. */
const TIMEOUT_MS = 12_000;

/** The default region for control-plane calls (STS/regions enumeration is global-ish). */
export const DEFAULT_AWS_REGION = "us-east-1";

/**
 * The audience the customer's IAM OIDC provider pins as its allowed client id — scoping the minted
 * assertion to AWS (mirrors GCP_TOKEN_AUDIENCE / AZURE_TOKEN_AUDIENCE / ALIBABA_TOKEN_AUDIENCE). MUST match
 * the `IssuerAudience` in the connector setup (alethia-bootstrap.yaml / aws.tf) or the exchange is rejected.
 */
export const AWS_TOKEN_AUDIENCE = "sts.amazonaws.com";

/** Whether this instance can federate to AWS at all (the workload-identity issuer is configured). */
export function awsConfigured(): boolean {
	return workloadAssertionSourceConfigured();
}

/** Extracts the 12-digit account id from a role ARN (arn:aws:iam::<account>:role/...). */
function accountIdFromArn(roleArn: string | null | undefined): string | null {
	if (!roleArn) return null;
	const m = roleArn.match(/^arn:aws[^:]*:iam::(\d{12}):/);
	return m?.[1] ?? null;
}

/**
 * Assumes the customer's role for one cloud identity via `AssumeRoleWithWebIdentity` and returns a
 * short-lived session. `AssumeRoleWithWebIdentity` is an unauthenticated STS action — the minted assertion
 * authenticates it, so the client needs no credentials. Throws on a missing role ARN, an unconfigured
 * issuer, or an assume failure (revoked trust / wrong sub/aud) — the caller maps that to DISCONNECTED.
 */
export async function assumeAwsRole(
	identity: Pick<CloudIdentity, "credentials">,
	opts?: { region?: string; purpose?: string },
): Promise<AwsSession> {
	const region = opts?.region ?? DEFAULT_AWS_REGION;
	const roleArn = identity.credentials.role_arn ?? null;
	if (!roleArn) throw new Error("This AWS connection has no role ARN.");
	if (!workloadAssertionSourceConfigured()) {
		throw new Error("The workload-identity issuer is not configured (ALETHIA_OIDC_SIGNING_KEY).");
	}

	const token = await assertionSourceForProvider("aws").getAssertion({
		audience: AWS_TOKEN_AUDIENCE,
	});
	const sts = new STSClient({
		region,
		requestHandler: { requestTimeout: TIMEOUT_MS },
		maxAttempts: 2,
	});
	const res = await sts.send(
		new AssumeRoleWithWebIdentityCommand({
			RoleArn: roleArn,
			WebIdentityToken: token,
			RoleSessionName: `alethia-${(opts?.purpose ?? "probe").slice(0, 24)}`,
			DurationSeconds: 3600,
		}),
	);
	const c = res.Credentials;
	if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken) {
		throw new Error("AssumeRoleWithWebIdentity returned no credentials.");
	}
	return {
		credentials: {
			accessKeyId: c.AccessKeyId,
			secretAccessKey: c.SecretAccessKey,
			sessionToken: c.SessionToken,
		},
		accountId: accountIdFromArn(roleArn),
		region,
	};
}
