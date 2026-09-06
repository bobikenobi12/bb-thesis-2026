"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// SSO identity-provider management. Reads are `member:view`; mutations are `member:manage_members`
// PLUS the Enterprise `sso` entitlement — enforced HERE (not in the ee/ better-auth guard, whose
// body matcher only sees an `organizationId` on /sso/register; update/delete/verify carry a
// `providerId`, so a matcher-based guard there would fail closed and 403 every legitimate admin).
// The mutations delegate to @better-auth/sso's own endpoints (which additionally enforce org-admin),
// so we never hand-roll provider CRUD.

import { X509Certificate } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";
import { emitAlertEventSafe } from "@/lib/alerts/emit";
import { auth } from "@/lib/auth";
import { getPdp } from "@/lib/authz";
import { recordActivity } from "@/lib/authz/activity";
import { getEntitlements } from "@/lib/authz/entitlements";
import { authorizeQuiet } from "@/lib/authz/guard";
import type { Actor } from "@/lib/authz/types";
import { getServiceDb } from "@/lib/db";
import { organization, ssoProvider } from "@/lib/db/schema";
import { safeFetch } from "@/lib/net/ssrf-guard";

/** OIDC or SAML — `unknown` when neither config is present (a broken/partial row). */
export type SsoProviderType = "oidc" | "saml" | "unknown";

export interface SsoProviderRow {
	id: string;
	providerId: string;
	domain: string;
	issuer: string;
	type: SsoProviderType;
	domainVerified: boolean;
	/** SAML IdP sign-on URL (entryPoint), if configured. */
	ssoUrl: string | null;
	/** SHA-256 fingerprint of the SAML signing certificate ("AB:CD:…"), if parseable. */
	certFingerprint: string | null;
	/** OIDC client id (never the secret), if configured. */
	clientId: string | null;
}

export interface SsoFilter {
	search?: string;
	types?: SsoProviderType[];
	/** "verified" | "pending" — the domain-verification state. */
	statuses?: ("verified" | "pending")[];
}

export interface SsoBootstrap {
	/** Enterprise entitlement. */
	sso: boolean;
	/** Non-throwing PDP check — drives whether mutating affordances are enabled. */
	canManage: boolean;
	/** Active org slug — used to build the SP-initiated start URL. */
	slug: string;
	/** Public origin, for the SP URLs shown to the IdP admin. */
	origin: string;
}

interface SamlCfg {
	entryPoint?: string;
	cert?: string;
}
interface OidcCfg {
	clientId?: string;
}

/** The mint-token response from /sso/request-domain-verification. */
const domainTokenResponse = z.object({ domainVerificationToken: z.string() });

/** The OIDC discovery document — only the fields the connection test asserts on. */
const discoveryDoc = z.object({
	issuer: z.string().optional(),
	authorization_endpoint: z.string().optional(),
	token_endpoint: z.string().optional(),
	jwks_uri: z.string().optional(),
});

function parseJson<T>(s: string | null): T | null {
	if (!s) return null;
	try {
		return JSON.parse(s);
	} catch {
		return null;
	}
}

/** SHA-256 fingerprint of a SAML signing cert (PEM or bare base64), or null. */
function certFingerprint(cert?: string): string | null {
	if (!cert) return null;
	try {
		const pem = cert.includes("BEGIN CERTIFICATE")
			? cert
			: `-----BEGIN CERTIFICATE-----\n${cert.replace(/\s+/g, "")}\n-----END CERTIFICATE-----`;
		return new X509Certificate(pem).fingerprint256;
	} catch {
		return null;
	}
}

/**
 * Which protocol a row is configured for. A row with an oidcConfig is OIDC; with a samlConfig,
 * SAML; with NEITHER it is broken — report `unknown` rather than silently claiming SAML (the
 * previous `oidcConfig ? "oidc" : "saml"` mislabelled every config-less row as SAML).
 */
function providerType(
	oidcConfig: string | null,
	samlConfig: string | null,
): SsoProviderType {
	if (oidcConfig) return "oidc";
	if (samlConfig) return "saml";
	return "unknown";
}

/** Mutations: PDP `manage_members` + the Enterprise `sso` entitlement. Both must pass. */
async function requireSsoAdmin(): Promise<Actor> {
	const actor = await authorizeQuiet("manage_members", { type: "member" });
	if (!getEntitlements(actor).sso) {
		throw new Error("Single Sign-On requires an Enterprise plan.");
	}
	return actor;
}

/**
 * Dispatches a better-auth endpoint through `auth.handler`, forwarding the caller's cookies.
 *
 * The SSO endpoints come from the `sso()` plugin, which is loaded through the ee/ seam
 * (getAuthPlugins) — so `auth.api` cannot statically know about them, and the open-core guard
 * forbids importing `@alethia/ee` here to recover the types. `auth.handler` is the typed,
 * cast-free dispatcher, and it still runs better-auth's own middleware (session resolution, the
 * plugin's org-admin `checkProviderAccess`, and the ee entitlement guard).
 */
async function callAuth(path: string, body: unknown): Promise<Response> {
	const h = await headers();
	const origin =
		process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ??
		"http://localhost:3000";
	const forwardedHeaders = new Headers(h);
	forwardedHeaders.set("content-type", "application/json");
	const res = await auth.handler(
		new Request(`${origin}/api/auth${path}`, {
			method: "POST",
			headers: forwardedHeaders,
			body: JSON.stringify(body),
		}),
	);
	if (!res.ok) {
		const text = await res.text();
		let message = text || `SSO request failed (HTTP ${res.status})`;
		try {
			const parsed: unknown = JSON.parse(text);
			if (
				typeof parsed === "object" &&
				parsed !== null &&
				"message" in parsed &&
				typeof parsed.message === "string"
			) {
				message = parsed.message;
			}
		} catch {
			// non-JSON body — keep the raw text
		}
		throw new Error(message);
	}
	return res;
}

/** Everything the SSO page needs that isn't the provider list. `member:view` gated. */
export async function getSsoBootstrap(): Promise<SsoBootstrap> {
	const actor = await authorizeQuiet("view", { type: "member" });
	const [org] = await getServiceDb()
		.select({ slug: organization.slug })
		.from(organization)
		.where(eq(organization.id, actor.orgId))
		.limit(1);
	const decision = await getPdp().can(actor, "manage_members", {
		type: "member",
	});
	return {
		sso: getEntitlements(actor).sso,
		canManage: decision.allowed,
		slug: org?.slug ?? "",
		origin:
			process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ??
			"https://alethialabs.io",
	};
}

/**
 * The active org's SSO providers, filtered SERVER-SIDE by search (providerId / domain / issuer),
 * protocol, and verification status. `member:view` gated.
 */
export async function listSsoProviders(
	filter: SsoFilter = {},
): Promise<SsoProviderRow[]> {
	const actor = await authorizeQuiet("view", { type: "member" });
	const rows = await getServiceDb()
		.select({
			id: ssoProvider.id,
			providerId: ssoProvider.providerId,
			domain: ssoProvider.domain,
			issuer: ssoProvider.issuer,
			oidcConfig: ssoProvider.oidcConfig,
			samlConfig: ssoProvider.samlConfig,
			domainVerified: ssoProvider.domainVerified,
		})
		.from(ssoProvider)
		.where(eq(ssoProvider.organizationId, actor.orgId));

	const q = filter.search?.trim().toLowerCase();
	return rows
		.map((r) => ({
			id: r.id,
			providerId: r.providerId,
			domain: r.domain,
			issuer: r.issuer,
			type: providerType(r.oidcConfig, r.samlConfig),
			domainVerified: r.domainVerified,
			ssoUrl: parseJson<SamlCfg>(r.samlConfig)?.entryPoint ?? null,
			certFingerprint: certFingerprint(
				parseJson<SamlCfg>(r.samlConfig)?.cert,
			),
			clientId: parseJson<OidcCfg>(r.oidcConfig)?.clientId ?? null,
		}))
		.filter((p) => {
			if (
				q &&
				!`${p.providerId} ${p.domain} ${p.issuer}`.toLowerCase().includes(q)
			) {
				return false;
			}
			if (filter.types?.length && !filter.types.includes(p.type)) return false;
			if (filter.statuses?.length) {
				const status = p.domainVerified ? "verified" : "pending";
				if (!filter.statuses.includes(status)) return false;
			}
			return true;
		});
}

/**
 * The active org's SSO providers, unfiltered.
 * @deprecated Superseded by {@link listSsoProviders}; retained until the SSO page is rebuilt.
 */
export async function getSsoProviders(): Promise<SsoProviderRow[]> {
	return listSsoProviders();
}

/** Resolves a provider that belongs to the actor's org (or throws). */
async function ownedProvider(actor: Actor, id: string) {
	const [row] = await getServiceDb()
		.select({
			id: ssoProvider.id,
			providerId: ssoProvider.providerId,
			domain: ssoProvider.domain,
			issuer: ssoProvider.issuer,
			oidcConfig: ssoProvider.oidcConfig,
			samlConfig: ssoProvider.samlConfig,
		})
		.from(ssoProvider)
		.where(
			and(eq(ssoProvider.id, id), eq(ssoProvider.organizationId, actor.orgId)),
		)
		.limit(1);
	if (!row) throw new Error("Provider not found");
	return row;
}

const SSO_PATH = "/[org]/~/settings/sso";

export interface SsoUpdateInput {
	/** Trust-domain the IdP asserts for. */
	domain?: string;
	issuer?: string;
	/** OIDC. Omit clientSecret to keep the stored one (never send it back to the client). */
	clientId?: string;
	clientSecret?: string;
	/** SAML. */
	entryPoint?: string;
	cert?: string;
	/** IdP claim → user field mapping, merged into the stored config. */
	mapping?: Record<string, string>;
}

/**
 * Updates a provider through @better-auth/sso's own endpoint. The plugin MERGES into the stored
 * oidc/saml config, so omitted secrets (clientSecret, cert) are preserved — we never round-trip a
 * secret to the browser just to save it back.
 */
export async function updateSsoProvider(
	id: string,
	input: SsoUpdateInput,
): Promise<void> {
	const actor = await requireSsoAdmin();
	const row = await ownedProvider(actor, id);

	const type = providerType(row.oidcConfig, row.samlConfig);
	const body: Record<string, unknown> = { providerId: row.providerId };
	if (input.domain) body.domain = input.domain;
	if (input.issuer) body.issuer = input.issuer;
	if (type === "oidc") {
		const oidcConfig: Record<string, unknown> = {};
		if (input.clientId) oidcConfig.clientId = input.clientId;
		if (input.clientSecret) oidcConfig.clientSecret = input.clientSecret;
		if (input.mapping) oidcConfig.mapping = input.mapping;
		if (Object.keys(oidcConfig).length > 0) body.oidcConfig = oidcConfig;
	} else if (type === "saml") {
		const samlConfig: Record<string, unknown> = {};
		if (input.entryPoint) samlConfig.entryPoint = input.entryPoint;
		if (input.cert) samlConfig.cert = input.cert;
		if (input.mapping) samlConfig.mapping = input.mapping;
		if (Object.keys(samlConfig).length > 0) body.samlConfig = samlConfig;
	}

	await callAuth("/sso/update-provider", body);

	emitAlertEventSafe(actor.orgId, "authz.sso.edit", {
		title: `SSO provider updated: ${row.providerId}`,
		severity: "warning",
		actor_id: actor.userId,
		action: "edit",
		resource_type: "sso_provider",
		resource_id: id,
	});
	recordActivity(actor, "edit", { type: "sso_provider", id });
	revalidatePath(SSO_PATH, "page");
}

/** Removes a provider (its users can no longer sign in through it). */
export async function deleteSsoProvider(id: string): Promise<void> {
	const actor = await requireSsoAdmin();
	const row = await ownedProvider(actor, id);

	await callAuth("/sso/delete-provider", { providerId: row.providerId });

	emitAlertEventSafe(actor.orgId, "authz.sso.delete", {
		title: `SSO provider removed: ${row.providerId}`,
		severity: "warning",
		actor_id: actor.userId,
		action: "delete",
		resource_type: "sso_provider",
		resource_id: id,
	});
	recordActivity(actor, "destroy", { type: "sso_provider", id });
	revalidatePath(SSO_PATH, "page");
}

/** Mints (or re-mints) the DNS TXT token proving control of the provider's domain. */
export async function requestSsoDomainVerification(
	id: string,
): Promise<{ record: string; token: string }> {
	const actor = await requireSsoAdmin();
	const row = await ownedProvider(actor, id);

	const res = await callAuth("/sso/request-domain-verification", {
		providerId: row.providerId,
	});
	const parsed = domainTokenResponse.safeParse(await res.json());
	if (!parsed.success) throw new Error("Could not mint a verification token.");

	// The plugin's record name is `_<tokenPrefix>-<providerId>` (RFC 8552 underscore-prefixed).
	return {
		record: `_alethia-sso-${row.providerId}`,
		token: parsed.data.domainVerificationToken,
	};
}

/** Checks the DNS TXT record and, on success, flips `domain_verified`. */
export async function verifySsoDomain(id: string): Promise<{ verified: boolean }> {
	const actor = await requireSsoAdmin();
	const row = await ownedProvider(actor, id);

	await callAuth("/sso/verify-domain", { providerId: row.providerId });

	emitAlertEventSafe(actor.orgId, "authz.sso.domain_verified", {
		title: `SSO domain verified: ${row.domain}`,
		severity: "info",
		actor_id: actor.userId,
		action: "edit",
		resource_type: "sso_provider",
		resource_id: id,
	});
	recordActivity(actor, "edit", { type: "sso_provider", id });
	revalidatePath(SSO_PATH, "page");
	return { verified: true };
}

export interface SsoTestCheck {
	id: string;
	label: string;
	ok: boolean;
	detail: string;
}
export interface SsoTestResult {
	ok: boolean;
	checks: SsoTestCheck[];
}

/**
 * A REAL connection preflight (replaces the old "coming soon" toast).
 *  - OIDC: fetch the issuer's discovery document and assert the endpoints + issuer match.
 *  - SAML: parse the signing certificate and assert it isn't expired, and the entryPoint is https.
 *
 * The OIDC fetch targets a TENANT-SUPPLIED url, so it goes through `safeFetch` (the repo's
 * hardened SSRF sink: https-only, DNS-resolve-then-pin against rebinding, private/loopback/
 * link-local/metadata-IP rejection, per-hop redirect re-validation).
 */
export async function testSsoProvider(id: string): Promise<SsoTestResult> {
	const actor = await requireSsoAdmin();
	const row = await ownedProvider(actor, id);
	const type = providerType(row.oidcConfig, row.samlConfig);
	const checks: SsoTestCheck[] = [];

	if (type === "oidc") {
		const url = `${row.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
		try {
			const res = await safeFetch(url, { headers: { accept: "application/json" } });
			checks.push({
				id: "discovery",
				label: "Discovery document",
				ok: res.ok,
				detail: res.ok ? `HTTP ${res.status}` : `HTTP ${res.status} from ${url}`,
			});
			if (res.ok) {
				const parsed = discoveryDoc.safeParse(await res.json());
				const doc = parsed.success ? parsed.data : {};
				for (const [key, label] of [
					["authorization_endpoint", "Authorization endpoint"],
					["token_endpoint", "Token endpoint"],
					["jwks_uri", "JWKS URI"],
				] as const) {
					const value = doc[key];
					checks.push({
						id: key,
						label,
						ok: Boolean(value),
						detail: value ?? "missing from the discovery document",
					});
				}
				const matches = doc.issuer?.replace(/\/$/, "") === row.issuer.replace(/\/$/, "");
				checks.push({
					id: "issuer",
					label: "Issuer matches",
					ok: matches,
					detail: matches
						? row.issuer
						: `document says "${doc.issuer ?? "—"}", provider says "${row.issuer}"`,
				});
			}
		} catch (err) {
			checks.push({
				id: "discovery",
				label: "Discovery document",
				ok: false,
				detail: err instanceof Error ? err.message : "request failed",
			});
		}
	} else if (type === "saml") {
		const saml = parseJson<SamlCfg>(row.samlConfig);
		try {
			const pem = saml?.cert?.includes("BEGIN CERTIFICATE")
				? saml.cert
				: `-----BEGIN CERTIFICATE-----\n${(saml?.cert ?? "").replace(/\s+/g, "")}\n-----END CERTIFICATE-----`;
			const cert = new X509Certificate(pem);
			const notAfter = new Date(cert.validTo);
			const valid = notAfter.getTime() > Date.now();
			checks.push({
				id: "cert",
				label: "Signing certificate",
				ok: valid,
				detail: valid
					? `valid until ${notAfter.toISOString().slice(0, 10)}`
					: `EXPIRED on ${notAfter.toISOString().slice(0, 10)}`,
			});
		} catch {
			checks.push({
				id: "cert",
				label: "Signing certificate",
				ok: false,
				detail: "could not be parsed",
			});
		}
		const entry = saml?.entryPoint ?? "";
		const https = entry.startsWith("https://");
		checks.push({
			id: "entrypoint",
			label: "IdP sign-on URL",
			ok: https,
			detail: https ? entry : "must be an https:// URL",
		});
	} else {
		checks.push({
			id: "config",
			label: "Provider configuration",
			ok: false,
			detail: "neither an OIDC nor a SAML config is stored — re-register this provider",
		});
	}

	return { ok: checks.every((c) => c.ok), checks };
}
