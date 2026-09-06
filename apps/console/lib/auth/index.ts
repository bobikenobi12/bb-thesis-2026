// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { emailOTP, genericOAuth, jwt } from "better-auth/plugins";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp } from "@better-auth/mcp";
import type {
	BetterAuthOptions,
	SocialProviders,
} from "better-auth";
import { getAuthConfig, getAuthRateLimit, getGitlabBaseUrl } from "@/lib/config/auth";
import { getAuthPlugins } from "@/lib/auth/plugins";
import { mcpResourceFromBaseUrl } from "@/lib/auth/mcp-resource";
import { ensureMemberGrant } from "@/lib/authz/grants";
import { provisionPrimaryOrg } from "@/lib/auth/onboarding";
import { getServiceDb } from "@/lib/db";
import {
	account,
	invitation,
	member,
	jwks,
	oauthAccessToken,
	oauthClient,
	oauthClientAssertion,
	oauthClientResource,
	oauthConsent,
	oauthRefreshToken,
	oauthResource,
	organization,
	rateLimit,
	session,
	ssoProvider,
	team,
	teamMember,
	user,
	verification,
} from "@/lib/db/schema";
import { profiles } from "@/lib/db/schema";
import { sendSignInCodeEmail } from "@/lib/email/auth-email";
import { sendWelcomeEmail } from "@/lib/email/notify-email";

const cfg = getAuthConfig();

// Native social providers (registered only when credentials are present).
const socialProviders: SocialProviders = {};
if (cfg.providers.github) {
	socialProviders.github = {
		clientId: cfg.providers.github.clientId,
		clientSecret: cfg.providers.github.clientSecret,
		// `repo` so the linked account's token can drive the git integrations
		// (full consolidation — the login account token IS the integration token).
		// Better Auth merges its read:user/user:email defaults, so only add repo.
		scope: ["repo"],
		// Capture the GitHub login (e.g. "bobikenobi12") → seeds the org slug.
		mapProfileToUser: (profile: { login?: string }) => ({
			username: profile.login,
		}),
	};
}
if (cfg.providers.google) {
	socialProviders.google = {
		clientId: cfg.providers.google.clientId,
		clientSecret: cfg.providers.google.clientSecret,
	};
}

// Self-hosted GitLab + Bitbucket via the generic OAuth plugin (registered only
// when configured). Scopes mirror the git provider link scopes.
const genericOAuthConfigs = [];
if (cfg.providers.gitlab) {
	genericOAuthConfigs.push({
		providerId: "gitlab",
		clientId: cfg.providers.gitlab.clientId,
		clientSecret: cfg.providers.gitlab.clientSecret,
		authorizationUrl: `${getGitlabBaseUrl()}/oauth/authorize`,
		tokenUrl: `${getGitlabBaseUrl()}/oauth/token`,
		userInfoUrl: `${getGitlabBaseUrl()}/api/v4/user`,
		scopes: [
			"read_api",
			"read_user",
			"read_repository",
			"read_registry",
			"openid",
			"profile",
			"email",
		],
		// GitLab returns `username` → seeds the org slug. Return type carries an
		// (unset) `name` so it isn't a "weak type" mismatch against Partial<User>;
		// `username` is persisted at runtime (the column is registered).
		mapProfileToUser: (
			profile: Record<string, unknown>,
		): { name?: string; username?: string } => ({
			username: typeof profile.username === "string" ? profile.username : undefined,
		}),
	});
}
if (cfg.providers.bitbucket) {
	genericOAuthConfigs.push({
		providerId: "bitbucket",
		clientId: cfg.providers.bitbucket.clientId,
		clientSecret: cfg.providers.bitbucket.clientSecret,
		authorizationUrl: "https://bitbucket.org/site/oauth2/authorize",
		tokenUrl: "https://bitbucket.org/site/oauth2/access_token",
		userInfoUrl: "https://api.bitbucket.org/2.0/user",
		scopes: ["account", "repository"],
		// Bitbucket returns `username` (legacy `nickname`) → seeds the org slug.
		mapProfileToUser: (
			profile: Record<string, unknown>,
		): { name?: string; username?: string } => {
			const handle = profile.username ?? profile.nickname;
			return { username: typeof handle === "string" ? handle : undefined };
		},
	});
}

const plugins: BetterAuthOptions["plugins"] = [
	emailOTP({
		otpLength: 6,
		expiresIn: 600, // 10 minutes — matches the email template copy.
		async sendVerificationOTP({ email, otp }) {
			await sendSignInCodeEmail(email, otp);
		},
	}),
	// REQUIRED by mcp(): it supplies the stable signing key for ID/access tokens and
	// exposes /jwks for resource servers to verify them. Without it mcp() has nothing
	// to sign with.
	jwt(),
];

/**
 * The canonical MCP resource identifier, or null when this deployment cannot form one.
 *
 * 1.7 makes `resource` mandatory and validates it at plugin construction: it must be an absolute
 * URL with no query, fragment or credentials (http only on loopback). That validation runs while
 * `betterAuth()` is being built, so a malformed baseURL would throw at MODULE LOAD and take the
 * whole auth surface down — sign-in included — over a feature most deployments never touch.
 *
 * So it is computed defensively and MCP is registered only when it succeeds, the same way the
 * social providers above are registered only when configured. A self-host with a missing or
 * relative NEXT_PUBLIC_APP_URL loses the MCP connector and keeps its login page.
 *
 * EXPORTED because it is the audience three separate things must agree on — see
 * lib/auth/mcp-resource.ts. The route that verifies MCP access tokens
 * (app/api/mcp/route.ts) and the route that serves the resource's RFC 9728 metadata
 * (app/api/oauth-protected-resource) both read this value rather than re-deriving one.
 */
export const mcpResourceUrl: string | null = mcpResourceFromBaseUrl(cfg.baseURL);

// OAuth 2.1 authorization server for the MCP endpoint (B7): lets remote MCP clients (Claude /
// claude.ai connectors) obtain an access token that the /api/mcp route resolves into a PDP-scoped
// actor. No new authority — the token's user drives getActiveScope() like any other caller.
//
// 1.7 moved this plugin into @better-auth/mcp, flattened the old `oidcConfig` nesting, and made
// `resource` mandatory: tokens are audience-bound to it (RFC 8707) and the RFC 9728
// protected-resource metadata is published for it. Its endpoints moved from /mcp/* to /oauth2/*.
const resource = mcpResourceUrl;
if (resource !== null) {
	// mcp() IS the OAuth provider — never also register oauthProvider() here.
	plugins.push(
		mcp({
			loginPage: "/login",
			// Shown when a client requests prompt=consent (e.g. a re-auth/scope grant);
			// clients that omit it are issued a code directly (documented MVP posture).
			consentPage: "/auth/oauth/consent",
			resource,
		}),
		// Client ID Metadata Documents. 1.7 stopped allowing unauthenticated Dynamic
		// Client Registration, which is how the connectors used to register themselves —
		// the replacement is CIMD, and discovery only advertises
		// `client_id_metadata_document_supported` when this plugin is loaded. Dropping it
		// without pre-registering clients would leave remote MCP clients no way to
		// register at all, so this is not optional in practice for us.
		cimd({ fetchClientMetadataResource, metadataProfile: "mcp-2026-07-28" }),
	);
}
if (genericOAuthConfigs.length > 0) {
	plugins.push(genericOAuth({ config: genericOAuthConfigs }));
}
// Enterprise plugins (organization, SSO) via the getAuthPlugins() seam — [] in the
// community build (lib/auth/plugins.ts).
plugins.push(...getAuthPlugins());
// nextCookies MUST be last so it can set cookies on the outgoing response.
plugins.push(nextCookies());

export const auth = betterAuth({
	secret: cfg.secret,
	baseURL: cfg.baseURL,
	trustedOrigins: [cfg.baseURL],
	database: drizzleAdapter(getServiceDb(), {
		provider: "pg",
		// organization/member/invitation + ssoProvider are mapped for the enterprise
		// organization + SSO plugins (getAuthPlugins); inert in community (the plugins
		// aren't loaded).
		schema: {
			user,
			session,
			account,
			verification,
			organization,
			member,
			invitation,
			team,
			teamMember,
			ssoProvider,
			// MCP OAuth authorization-server tables. 1.7's mcp() IS oauthProvider(), whose schema
			// is registered UNCONDITIONALLY — every model must appear here even for features we
			// never use, or the adapter throws "the model \"x\" was not found in the schema
			// object" the first time the plugin touches it. `jwks` belongs to jwt(), which
			// oauth-provider requires.
			oauthClient,
			oauthResource,
			oauthClientResource,
			oauthRefreshToken,
			oauthAccessToken,
			oauthConsent,
			oauthClientAssertion,
			jwks,
			// Built-in rate limiter's backing store (rateLimit: storage "database").
			rateLimit,
		},
	}),
	// DB-backed brute-force throttle for /api/auth/* (sign-in / email-OTP). Replica-
	// consistent, unlike the per-process lib/rate-limit.ts. See getAuthRateLimit().
	rateLimit: getAuthRateLimit(),
	// UUID ids so user.id populates every `user_id uuid` column + the RLS
	// backstop (current_setting('app.current_owner')::uuid).
	advanced: {
		database: { generateId: "uuid" },
		// Trust exactly the single-value header the deployment's edge overwrites. The hosted default is
		// cf-connecting-ip; a self-host may name its proxy's equivalent. The catch-all route refuses
		// production auth when the header is absent or malformed, before Better Auth can collapse every
		// user into its shared `no-trusted-ip` rate-limit bucket.
		ipAddress: { ipAddressHeaders: [cfg.trustedIpHeader] },
	},
	emailAndPassword: { enabled: false },
	socialProviders,
	// `username` is populated server-side from the OAuth profile (mapProfileToUser),
	// never from client input — it seeds the auto-created org slug.
	user: {
		additionalFields: {
			username: { type: "string", required: false, input: false },
			// Server-managed (input:false) — set when the user finishes /onboarding.
			onboardingCompletedAt: { type: "date", required: false, input: false },
			// Server-managed (input:false) — set the first time the account starts its
			// single Pro trial (one-per-account, see startProTrial / getProOffer).
			proTrialConsumedAt: { type: "date", required: false, input: false },
		},
	},
	account: {
		accountLinking: {
			enabled: true,
			trustedProviders: ["github", "google", "gitlab", "bitbucket"],
			// The git providers are connected FOR THEIR REPOS, so the linked account's email
			// routinely differs from the console login email (e.g. a Google/email-OTP login
			// linking a GitHub account under a different address). Without this, Better Auth
			// rejects the link on an email mismatch and redirects back with an error — which is
			// exactly the "login works but Connect GitHub/GitLab/Bitbucket doesn't" symptom on
			// prod. Safe because every provider here is in `trustedProviders` (OAuth-verified).
			allowDifferentEmails: true,
		},
	},
	databaseHooks: {
		user: {
			create: {
				after: async (u) => {
					await upsertProfile(u);
					// Owner of the personal scope (org_id == user.id) — grant + FGA tuple.
					// Best-effort: this mirrors into OpenFGA, so an unreachable PDP used to
					// throw straight out of the hook and abort the rest of it — including the
					// org provisioning below, which is what actually gets the user into the app.
					await ensureMemberGrant(u.id, u.id, "owner").catch((e) =>
						console.error("[onboarding] personal-scope grant failed:", e),
					);
					// Auto-create a real, named org (slug = username) and make it primary.
					//
					// A failure here used to be logged and forgotten, which left a user row with
					// NO membership and a NULL `onboarding_completed_at`. That pair is not a
					// cosmetic gap: /dashboard sends such a user to /onboarding and /onboarding
					// sent them back, so they were signed in and looping forever, never landing in
					// the app. The loop is now broken on the read side too (both pages), and
					// /onboarding repairs a missing org in place — but keep this loud, because a
					// repeated failure here means the PDP or the DB is unhealthy, not that one
					// signup was unlucky.
					await provisionPrimaryOrg({
						id: u.id,
						email: u.email,
						name: u.name ?? null,
						username: readUsername(u),
					}).catch((e) => console.error("[onboarding] org provision failed:", e));
					// Best-effort welcome (general stream); never block signup on email.
					void sendWelcomeEmail(u.email).catch((e) =>
						console.error("[email] welcome send failed:", e),
					);
				},
			},
			update: {
				after: async (u) => {
					await upsertProfile(u);
				},
			},
		},
	},
	plugins,
});

/**
 * Mirrors the Better Auth user into the legacy `profiles` table (id == user.id)
 * so CLI auth + display + the cli_logins.profile_id FK keep working unchanged.
 */
async function upsertProfile(u: {
	id: string;
	email: string;
	name?: string | null;
	image?: string | null;
}): Promise<void> {
	await getServiceDb()
		.insert(profiles)
		.values({
			id: u.id,
			email: u.email,
			full_name: u.name ?? null,
			avatar_url: u.image ?? null,
		})
		.onConflictDoUpdate({
			target: profiles.id,
			set: { email: u.email, full_name: u.name ?? null, avatar_url: u.image ?? null },
		});
}

/** Reads the optional `username` additional field off the created user, if present. */
function readUsername(u: object): string | null {
	if ("username" in u && typeof u.username === "string") return u.username;
	return null;
}
