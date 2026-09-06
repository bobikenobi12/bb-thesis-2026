// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Alethia workload-identity OIDC issuer. The control plane is its own OIDC identity provider so the
// managed cloud connectors can federate KEYLESSLY: it mints a short-lived, per-cloud-scoped JWT signed
// with a private key held only in the vault, and publishes the matching public JWKS + discovery document
// so a customer's cloud (Azure federated identity, Alibaba RAM OIDC provider) can verify it.
//
// This is deliberately minimal and single-purpose — NOT a general OAuth server (that's the separate MCP
// provider under /api/auth). It has no interactive/user surface: the only public routes are the discovery
// document and the JWKS, both static signed material. Server-only.

import { createPublicKey } from "node:crypto";
import {
	MAX_ASSERTION_TTL_SECONDS,
	MIN_ASSERTION_TTL_SECONDS,
	WORKLOAD_SUBJECT,
	type WorkloadAssertionRequest,
} from "@repo/workload-identity";
import * as jose from "jose";

/** RS256 — the widest-compatible alg for cloud workload-identity federation (Azure/Alibaba/GCP). */
const ALG = "RS256";

/** Issuer path under the app origin. The full issuer is `${APP_URL}/api/oidc`. */
const ISSUER_PATH = "/api/oidc";

/**
 * The single stable, non-secret workload subject. It is the `sub` of every minted token and MUST match
 * the Azure federated-credential subject + the Alibaba RAM-role OIDC condition. Never per-customer.
 */
export { WORKLOAD_SUBJECT } from "@repo/workload-identity";

/** Env var holding the base64-encoded PKCS8 PEM private key (single line; auto-generated in the vault). */
const SIGNING_KEY_ENV = "ALETHIA_OIDC_SIGNING_KEY";

/**
 * Optional SECOND signing key, published-but-not-signing, used ONLY during a key rotation. Zero-downtime
 * rollover: a cloud caches our JWKS (Azure for ~24h), so a new key must be PUBLISHED and trusted before we
 * sign with it, and the old key must keep verifying in-flight assertions after we stop signing with it.
 * The rotate flow (`scripts/rotate-oidc-key.sh`) parks the outgoing key here while the incoming key becomes
 * the primary; after the overlap window it's cleared. See lib/oidc — `getPublicJwks` publishes both.
 */
const PREVIOUS_KEY_ENV = "ALETHIA_OIDC_SIGNING_KEY_PREVIOUS";

interface LoadedKey {
	privateKey: CryptoKey;
	/** The public JWK published in the JWKS (kid/alg/use set; no private fields). */
	publicJwk: jose.JWK;
	kid: string;
}

/** The issuer keyring: the one key we sign with, plus every key we publish for verification. */
interface Keyring {
	/** The primary key — the ONLY key `mintWorkloadToken` signs with. */
	signing: LoadedKey;
	/** All configured keys (primary first), published in the JWKS so both old + new assertions verify. */
	all: LoadedKey[];
}

let cached: Keyring | null = null;

/** Whether the issuer is configured on this instance (drives connector availability for Azure/Alibaba). */
export function oidcIssuerConfigured(): boolean {
	return !!process.env[SIGNING_KEY_ENV];
}

/** The full issuer URL (`${APP_URL}/api/oidc`) — the value clouds trust + the token `iss`. */
export function issuerUrl(): string {
	const base = (
		process.env.NEXT_PUBLIC_APP_URL ||
		process.env.BETTER_AUTH_URL ||
		""
	).replace(/\/+$/, "");
	return `${base}${ISSUER_PATH}`;
}

/** Decodes + imports one base64(PKCS8 PEM) key and derives its public JWK (kid = JWK thumbprint). */
async function importKey(b64: string, envName: string): Promise<LoadedKey> {
	let pem: string;
	try {
		pem = Buffer.from(b64, "base64").toString("utf8");
	} catch {
		throw new Error(`${envName} is not valid base64.`);
	}
	const privateKey = await jose.importPKCS8(pem, ALG, { extractable: false });
	// Derive the public JWK from the private PEM (never expose private fields in the JWKS).
	const publicJwk = await jose.exportJWK(createPublicKey({ key: pem }));
	const kid = await jose.calculateJwkThumbprint(publicJwk);
	publicJwk.kid = kid;
	publicJwk.alg = ALG;
	publicJwk.use = "sig";
	return { privateKey, publicJwk, kid };
}

/** Loads the keyring — the primary (signing) key plus any published-only rotation key (memoized). */
async function load(): Promise<Keyring> {
	if (cached) return cached;
	const primaryB64 = process.env[SIGNING_KEY_ENV];
	if (!primaryB64) {
		throw new Error(`OIDC issuer not configured (${SIGNING_KEY_ENV}).`);
	}
	const signing = await importKey(primaryB64, SIGNING_KEY_ENV);
	const all: LoadedKey[] = [signing];

	// A second key is published (never used to sign) only during a rotation overlap. Ignore it if it's
	// blank or accidentally identical to the primary (a half-applied roll) so the JWKS stays deduped.
	const previousB64 = process.env[PREVIOUS_KEY_ENV];
	if (previousB64 && previousB64 !== primaryB64) {
		const previous = await importKey(previousB64, PREVIOUS_KEY_ENV);
		if (previous.kid !== signing.kid) all.push(previous);
	}

	cached = { signing, all };
	return cached;
}

/** Resets the memoized keyring — for tests that swap the env between cases. */
export function __resetIssuerCache(): void {
	cached = null;
}

/**
 * The public JWKS (`{ keys: [...] }`) served at `${issuer}/jwks` for clouds to verify assertions. During a
 * rotation this carries BOTH the new and the outgoing key; each assertion's `kid` header selects the right
 * one, so old and new tokens both verify through the overlap.
 */
export async function getPublicJwks(): Promise<{ keys: jose.JWK[] }> {
	const { all } = await load();
	return { keys: all.map((k) => k.publicJwk) };
}

/** The OIDC discovery document served at `${issuer}/.well-known/openid-configuration`. */
export async function discoveryDocument(): Promise<Record<string, unknown>> {
	const iss = issuerUrl();
	return {
		issuer: iss,
		jwks_uri: `${iss}/jwks`,
		// A workload-identity issuer: no interactive endpoints. These fields satisfy the validators that
		// fetch discovery (Azure/Alibaba) — only issuer + jwks_uri are load-bearing for federation.
		response_types_supported: ["id_token"],
		subject_types_supported: ["public"],
		id_token_signing_alg_values_supported: [ALG],
		scopes_supported: ["openid"],
		claims_supported: ["iss", "sub", "aud", "iat", "exp"],
	};
}

/**
 * Mints a short-lived assertion for one cloud's token exchange. `audience` is the cloud's expected
 * audience (e.g. `api://AzureADTokenExchange`, or the Alibaba OIDC client id) — scoping the token so it
 * can't be replayed at a different cloud. `subject` defaults to the fixed workload subject.
 */
export async function mintWorkloadToken(
	opts: WorkloadAssertionRequest,
): Promise<string> {
	const { signing } = await load();
	const { privateKey, kid } = signing;
	const now = Math.floor(Date.now() / 1000);
	const ttl = Math.min(
		Math.max(
			opts.ttlSeconds ?? MAX_ASSERTION_TTL_SECONDS,
			MIN_ASSERTION_TTL_SECONDS,
		),
		MAX_ASSERTION_TTL_SECONDS,
	);
	return await new jose.SignJWT({})
		.setProtectedHeader({ alg: ALG, kid, typ: "JWT" })
		.setIssuer(issuerUrl())
		.setSubject(opts.subject ?? WORKLOAD_SUBJECT)
		.setAudience(opts.audience)
		.setIssuedAt(now)
		.setExpirationTime(now + ttl)
		.sign(privateKey);
}
