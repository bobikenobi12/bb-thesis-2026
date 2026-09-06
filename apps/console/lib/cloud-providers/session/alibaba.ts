// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Alibaba session — KEYLESS and ACCOUNT-FREE. Alethia holds NO Alibaba account: instead of a platform
// RAM user's AccessKey, the console calls STS `AssumeRoleWithOIDC` with an assertion minted by the
// Alethia OIDC issuer (lib/oidc/issuer.ts). The customer registers a RAM OIDC IdP that trusts the
// issuer + a RAM role; both the provider ARN and role ARN are metadata on the identity (zero secrets
// stored). `AssumeRoleWithOIDC` is an anonymous STS action — authenticated by the OIDC token itself,
// so there is no AccessKey and no request signature. A successful assume is the proof of access.

import {
	assertionSourceForProvider,
	workloadAssertionSourceConfigured,
} from "@/lib/oidc/assertion-source";
import { toStr } from "@/lib/coerce";
import { asRecord } from "@/lib/records";
import type { CloudIdentity } from "@/lib/db/schema";

const STS_ENDPOINT = "https://sts.aliyuncs.com/";
const TIMEOUT_MS = 12_000;

/**
 * The audience the minted assertion carries. It must match a client-id (`aud`) configured on the
 * customer's RAM OIDC provider — the customer setup (Phase 3 Bit E) pins the provider to this value.
 */
export const ALIBABA_TOKEN_AUDIENCE = "sts.aliyuncs.com";

/**
 * The fixed name of the RAM OIDC provider the customer setup (`infra/connector/alibaba`) creates.
 * Because it's fixed, the console derives the provider ARN from the role ARN's account id instead of
 * asking the customer to paste it — so the connect form stays a single field. The IaC MUST use this
 * exact name (`oidc_provider_name = "alethia"`) or the derived ARN won't resolve.
 */
export const ALIBABA_OIDC_PROVIDER_NAME = "alethia";

/** Temporary STS credentials returned by AssumeRoleWithOIDC (used to call regional APIs, e.g. inventory). */
export interface AlibabaCredentials {
	accessKeyId: string;
	accessKeySecret: string;
	securityToken: string;
	/** ISO expiration; the creds are short-lived (~1h). */
	expiration: string | null;
}

/** Result of assuming the customer RAM role. */
export interface AlibabaSession {
	/** The account id we authenticated into (from the role ARN). */
	accountId: string | null;
	/** The temporary STS credentials from the assume. Present on success; used for inventory/API calls. */
	credentials: AlibabaCredentials | null;
}

/** acs:ram::<account>:role/Name → <account>. */
export function accountIdFromArn(roleArn: string | null | undefined): string | null {
	if (!roleArn) return null;
	const m = roleArn.match(/^acs:ram::(\d+):role\//);
	return m?.[1] ?? null;
}

/**
 * Derives the RAM OIDC provider ARN from a role ARN's account id + the fixed provider name — so the
 * connect flow only needs the role ARN. Returns null if the account id can't be parsed.
 */
export function deriveOidcProviderArn(roleArn: string | null | undefined): string | null {
	const accountId = accountIdFromArn(roleArn);
	return accountId ? `acs:ram::${accountId}:oidc-provider/${ALIBABA_OIDC_PROVIDER_NAME}` : null;
}

/**
 * Assumes the customer's RAM role for one Alibaba cloud identity via `AssumeRoleWithOIDC`. Throws when
 * the issuer isn't configured, the role/provider ARN is missing, or STS rejects the token (revoked
 * trust / wrong policy) — the caller maps that to DISCONNECTED. On success the assume itself is the
 * proof of access; we return the account id.
 */
export async function assumeAlibabaRole(
	identity: Pick<CloudIdentity, "credentials">,
	opts?: { purpose?: string },
): Promise<AlibabaSession> {
	if (!workloadAssertionSourceConfigured()) {
		throw new Error("The workload-identity issuer is not configured (ALETHIA_OIDC_SIGNING_KEY).");
	}
	const roleArn = identity.credentials.role_arn ?? null;
	if (!roleArn) throw new Error("This Alibaba connection has no role ARN.");
	const oidcProviderArn = identity.credentials.oidc_provider_arn ?? null;
	if (!oidcProviderArn) {
		throw new Error("This Alibaba connection has no OIDC provider ARN.");
	}

	const oidcToken = await assertionSourceForProvider("alibaba").getAssertion({
		audience: ALIBABA_TOKEN_AUDIENCE,
	});

	// AssumeRoleWithOIDC is anonymous — the OIDC token authenticates the call, so there is no
	// AccessKeyId / SignatureMethod / Signature. We deliberately send NO SignatureNonce/Timestamp
	// either: those are signature common-params, and including them on an UNSIGNED request makes the
	// RPC gateway treat it as a to-be-signed call and reject it with a missing-Signature error. Only the
	// action-specific params go in the form-encoded POST body.
	const params: Record<string, string> = {
		Action: "AssumeRoleWithOIDC",
		OIDCProviderArn: oidcProviderArn,
		RoleArn: roleArn,
		OIDCToken: oidcToken,
		RoleSessionName: `alethia-${(opts?.purpose ?? "probe").slice(0, 24)}`,
		DurationSeconds: "3600",
		Version: "2015-04-01",
		Format: "JSON",
	};
	const body = new URLSearchParams(params).toString();

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const res = await fetch(STS_ENDPOINT, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body,
			signal: controller.signal,
		});
		const resBody = asRecord(await res.json().catch(() => ({})));
		if (!res.ok || resBody.Code) {
			throw new Error(
				toStr(resBody.Message) ||
					toStr(resBody.Code) ||
					`Alibaba STS HTTP ${res.status}`,
			);
		}
		const c = asRecord(resBody.Credentials);
		const accessKeyId = toStr(c.AccessKeyId);
		const accessKeySecret = toStr(c.AccessKeySecret);
		const securityToken = toStr(c.SecurityToken);
		if (!accessKeyId || !accessKeySecret || !securityToken) {
			throw new Error("Alibaba AssumeRoleWithOIDC returned no credentials.");
		}
		return {
			accountId: accountIdFromArn(roleArn),
			credentials: {
				accessKeyId,
				accessKeySecret,
				securityToken,
				expiration: toStr(c.Expiration) || null,
			},
		};
	} finally {
		clearTimeout(timer);
	}
}
