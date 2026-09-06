// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Persona signup flows for the QA e2e suite. Each persona is a real account created once (serially,
// in global-setup) via the email-OTP flow; its Better Auth session is saved as a Playwright
// storageState so specs reuse it without racing the shared OTP log. See global-setup.ts.
//
// Personas:
//   ownerHobby — free-org owner (default surface for read/nav specs).
//   ownerTeam  — Pro (card-less trial) org owner; drives billing/seats/invite/RBAC breadth.
//   member     — invited into ownerTeam's org with the built-in `member` role, through the
//                PRODUCT'S OWN invite → accept endpoints (see buildMemberPersona below).
//
// Selectors come from components/auth/auth-form.tsx and components/auth/onboarding-form.tsx.

import { type Page } from "@playwright/test";
import path from "node:path";
import { ACCEPTANCE_LABELS } from "@repo/legal/documents";
import { CONSENT_LABELS } from "@repo/privacy/consent";
import { db, pendingInvitationId } from "./db";
import { logCursor, waitForOtp } from "./otp";

/** Where per-persona storageState + resolved metadata live (gitignored). Anchored on the package cwd
 * (apps/console when Playwright runs) so it works under Playwright's CJS loader. */
export const AUTH_DIR = path.resolve(process.cwd(), "e2e/.auth");

export type PersonaName = "ownerHobby" | "ownerTeam" | "member";

/** Written by global-setup, read by fixtures: session file + the org each persona lands in. */
export interface PersonaRecord {
	name: PersonaName;
	email: string;
	orgSlug: string;
	orgId?: string;
	userId?: string;
	storageState: string;
	/** For `member`: the built-in organization role its membership row actually carries. */
	role?: string;
}

export function storageStatePath(name: PersonaName): string {
	return path.join(AUTH_DIR, `${name}.json`);
}

export function personaMetaPath(): string {
	return path.join(AUTH_DIR, "personas.json");
}

/**
 * A unique email per persona per run — and per ATTEMPT.
 *
 * The attempt suffix is not tidiness. Signup creates the account at OTP verification and then still
 * has to walk onboarding and the clickwrap; a failure in either of those — precisely the transient
 * case global-setup's retry exists for — leaves a REAL account behind. Retried on the SAME address
 * the walk is a sign-in, `/onboarding` never appears, and every later attempt is guaranteed to time
 * out. Measured on the audit's T7 persona (e2e/audit/permissions.spec.ts) before it was fixed there.
 */
export function personaEmail(name: PersonaName, stamp: number, attempt = 1): string {
	return `e2e-${name.toLowerCase()}-${stamp}-${attempt}@alethia.test`;
}

/**
 * Requests an email-OTP code for `email` on /signup (or /login) and submits it, landing the account
 * on whatever comes next (/onboarding for new accounts, the app for returning ones). Shared by every
 * persona flow; the caller captures the log cursor timing via waitForOtp internally.
 */
export async function emailOtpSignIn(page: Page, email: string, mode: "signup" | "login"): Promise<void> {
	const cursor = await logCursor();
	await page.goto(`/${mode}`);
	await dismissConsentBanner(page);
	await page.getByRole("button", { name: /continue with email/i }).click();
	await page.locator("#email").fill(email);
	await page.getByRole("button", { name: /continue with email/i }).click();
	// Per-RECIPIENT, not "the newest code in the log". global-setup is serial, but the QA env is
	// shared with whatever else is signing in on it (the audit project, a person in a browser), and
	// a generic match would hand this persona somebody else's code and fail on a valid stack.
	const code = await waitForOtp(cursor, { email });
	await page.locator("input[data-input-otp]").first().fill(code);
}

/**
 * Makes the first-party privacy choice a fresh browser must make before the product journey.
 *
 * Tolerant of the banner not being there: it is a per-context decision, so a context restored from
 * a storageState has already made it. Located by the exported constant, not a literal — this
 * locator broke silently once when the button was relabelled for consent v2.
 */
async function dismissConsentBanner(page: Page): Promise<void> {
	const reject = page.getByRole("button", { name: CONSENT_LABELS.reject, exact: true });
	try {
		await reject.waitFor({ state: "visible", timeout: 8_000 });
	} catch {
		return; // already decided, or this deployment does not gate on it
	}
	await reject.click();
}

/**
 * Walks the post-auth clickwrap if it is showing, and returns once it is not.
 *
 * The gate (#2372) redirects every route under (private) to /accept-terms until the account has
 * accepted the CURRENT Terms, so a brand-new account meets it between onboarding and the org. The
 * July persona factory predates it and walked straight from "Create organization" to a
 * `waitForURL(/{slug})` that could therefore never resolve — /accept-terms is a single segment and
 * was not in NON_ORG_SEGMENTS either, so the wait resolved on the GATE and called it the org slug.
 */
async function acceptCurrentTerms(page: Page): Promise<void> {
	const accept = page.getByRole("button", { name: ACCEPTANCE_LABELS.submit });
	try {
		await accept.waitFor({ state: "visible", timeout: 15_000 });
	} catch {
		return; // already accepted — nothing to walk
	}
	await page
		.getByText(new RegExp(ACCEPTANCE_LABELS.checkboxPrefix, "i"))
		.first()
		.click();
	await accept.click();
	await accept.waitFor({ state: "hidden", timeout: 30_000 });
}

/** Resolves the org slug from the current post-onboarding URL (/{slug}). */
function slugFromUrl(page: Page): string {
	return page.url().replace(/^https?:\/\/[^/]+\//, "").replace(/[/?#].*$/, "");
}

/** Public single-segment routes that are NOT an org slug — the landing wait must skip past them.
 * `accept-terms` and `dashboard` are load-bearing: both are single-segment paths a new account
 * passes THROUGH, so without them the wait resolves on a waypoint and reports it as the org. */
const NON_ORG_SEGMENTS = new Set([
	"signup",
	"login",
	"onboarding",
	"accept-terms",
	"invites",
	"start",
	"cli",
	"dashboard",
]);

/** Waits until the URL is a real org overview (/{slug}), i.e. a single segment that isn't a known
 * public route. Onboarding's own `/onboarding` is a single segment, so it must be excluded. */
async function waitForOrgLanding(page: Page): Promise<string> {
	await page.waitForURL(
		(url) => {
			const parts = url.pathname.split("/").filter(Boolean);
			return parts.length === 1 && !NON_ORG_SEGMENTS.has(parts[0]);
		},
		{ timeout: 30_000 },
	);
	return slugFromUrl(page);
}

/**
 * A per-ACCOUNT organization name, so the slug it derives can never collide.
 *
 * MEASURED, not hypothetical. The name used to be the literal "E2E Hobby Org", which slugifies to
 * `e2e-hobby-org` — a globally unique column. The second Hobby signup in a run (the `member`
 * persona's own account) therefore got a 500 from `configureOnboardingOrg` — "That slug is taken —
 * try another." — the form stayed on /onboarding, and the walk died 30s later in a
 * `waitForURL(/{slug}/)` that named the wait rather than the cause. The same collision made the
 * whole factory single-use per environment database: a second `pnpm ... --project=qa` on one env
 * failed on ownerHobby.
 *
 * `fixtures/auth.ts` already derives its org name from the address for exactly this reason.
 */
function orgNameFor(kind: string, email: string): string {
	return `E2E ${kind} ${email.split("@")[0]}`;
}

/**
 * Signs up a fresh account and completes onboarding on the Hobby (free) plan, landing on the org
 * overview at /{slug}. Returns the resolved org slug.
 */
export async function signUpHobby(page: Page, email: string): Promise<{ orgSlug: string }> {
	await emailOtpSignIn(page, email, "signup");
	await page.waitForURL(/\/onboarding/, { timeout: 30_000 });
	await page.locator("#org-name").fill(orgNameFor("Hobby", email));
	// Hobby (community) tile is selected by default; click it for determinism, then create.
	await page.getByRole("button", { name: /personal projects/i }).click();
	await page.getByRole("button", { name: /create organization/i }).click();
	await acceptCurrentTerms(page);
	const orgSlug = await waitForOrgLanding(page);
	return { orgSlug };
}

/**
 * Signs up a fresh account and completes onboarding on the Pro plan via the card-less trial (a fresh
 * account still holds its one account-wide trial). Lands on the org overview. Returns the org slug.
 * Falls back to Hobby if the Pro tile is unavailable (Stripe unconfigured on this deployment).
 */
export async function signUpTeamTrial(page: Page, email: string): Promise<{ orgSlug: string; plan: "team" | "community" }> {
	await emailOtpSignIn(page, email, "signup");
	await page.waitForURL(/\/onboarding/, { timeout: 30_000 });
	await page.locator("#org-name").fill(orgNameFor("Team", email));
	const proTile = page.getByRole("button", { name: /commercial projects/i });
	const proDisabled = await proTile.isDisabled().catch(() => true);
	if (proDisabled) {
		// Stripe not configured — record intent to fall back so the suite still runs.
		await page.getByRole("button", { name: /personal projects/i }).click();
		await page.getByRole("button", { name: /create organization/i }).click();
		await acceptCurrentTerms(page);
		const orgSlug = await waitForOrgLanding(page);
		return { orgSlug, plan: "community" };
	}
	await proTile.click();
	// Trial path shows "Create organization" (card-less); paid path shows "Continue to payment".
	// A fresh account should always get the trial; guard for the paid label just in case.
	const createBtn = page.getByRole("button", { name: /create organization/i });
	const payBtn = page.getByRole("button", { name: /continue to payment/i });
	if (await payBtn.isVisible().catch(() => false)) {
		// No trial available (shouldn't happen for a fresh account) — bail to community.
		await page.getByRole("button", { name: /personal projects/i }).click();
		await createBtn.click();
	} else {
		await createBtn.click();
	}
	await acceptCurrentTerms(page);
	const orgSlug = await waitForOrgLanding(page);
	return { orgSlug, plan: "team" };
}

/**
 * Calls a better-auth organization endpoint from inside the page, so the request carries the
 * session cookie exactly as the console's own invite dialog does.
 */
export async function organizationApi(
	page: Page,
	endpoint: string,
	body: unknown,
): Promise<{ status: number; text: string }> {
	return page.evaluate(
		async ([p, payload]) => {
			const res = await fetch(`/api/auth/organization/${p}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
			});
			return { status: res.status, text: (await res.text()).slice(0, 400) };
		},
		[endpoint, body] as const,
	);
}

/**
 * Grants `orgId` the `organizations` entitlement by writing a team/active billing record.
 *
 * INVITING IS A PAID FEATURE, ENFORCED AT THE ENDPOINT. `app/api/auth/[...all]/route.ts` gates
 * `invite-member` on the `organizations` entitlement, so an org resolving COMMUNITY entitlements
 * gets `403 upgrade_required` — not from the dialog, from the API. `ownerTeam` is *supposed* to be
 * a Pro trial, but `signUpTeamTrial` falls back to Hobby wherever Stripe is unconfigured (which is
 * every branch env), and `resolveEntitlements` only honours `active`/`trialing`.
 *
 * This is a fixture, not a bypass: the gate itself stays exercised — `ownerHobby`'s org is left
 * untouched, and rbac.spec.ts's community-vs-Pro ladder still reads the real refusal there.
 */
export async function grantOrganizationsEntitlement(orgId: string): Promise<{ plan: string; status: string }> {
	await db()`
		insert into organization_billing (organization_id, plan, status)
		values (${orgId}, 'team', 'active')
		on conflict (organization_id) do update set plan = 'team', status = 'active'`;
	const rows = await db()<{ plan: string; status: string }[]>`
		select plan, status from organization_billing where organization_id = ${orgId}`;
	const row = rows[0];
	if (!row) throw new Error(`no organization_billing row for ${orgId} after the grant`);
	return row;
}

/** What buildMemberPersona resolved, so the caller can record and assert on it. */
export interface MemberPersonaResult {
	/** The org the member was invited INTO — what specs must drive, not the member's own org. */
	orgSlug: string;
	orgId: string;
	/** The member's own Hobby org, created by its signup. Kept so a spec can tell them apart. */
	ownOrgSlug: string;
	/** The role its `member` row actually carries, read back from the database. */
	role: string;
	userId: string;
	invitationId: string;
}

/**
 * Builds the `member` persona through the REAL invite → accept flow.
 *
 * Nothing is written straight into `member`: a raw row would skip whatever the accept path does to
 * provision access, and the persona would then be denied EVERYWHERE for a reason that has nothing
 * to do with roles — which is the failure mode that makes an RBAC negative suite report a column of
 * green while measuring nothing. The walk is:
 *
 *   1. the invitee signs itself up first (its own Hobby org), so it is a real account with a
 *      session — and so the invitation is addressed to an account that EXISTS;
 *   2. the target org is granted the `organizations` entitlement (see above);
 *   3. the owner POSTs `organization/invite-member` from its own cookie-bearing page;
 *   4. the invitation row is read back from the database and the invitee POSTs
 *      `organization/accept-invitation`;
 *   5. the membership row is read back and its ROLE returned — so the caller records what the
 *      database says, never what this function intended.
 *
 * Order matters: the invitee signs up BEFORE the invitation is sent, because a retried signup
 * (correctly) mints a fresh address, and an invitation addressed to the pre-retry address would
 * name an account that does not exist.
 */
export async function buildMemberPersona(args: {
	ownerPage: Page;
	memberPage: Page;
	memberEmail: string;
	/** The org to invite into — ownerTeam's. */
	orgId: string;
	orgSlug: string;
	/** The built-in organization role to invite with. */
	role?: string;
}): Promise<MemberPersonaResult> {
	const { ownerPage, memberPage, memberEmail, orgId, orgSlug } = args;
	const role = args.role ?? "member";

	// 1. The invitee is a real account before it is anybody's member.
	const { orgSlug: ownOrgSlug } = await signUpHobby(memberPage, memberEmail);

	// 2. The paid gate.
	const billing = await grantOrganizationsEntitlement(orgId);

	// 3. Invite, from the owner's session.
	const invited = await organizationApi(ownerPage, "invite-member", { email: memberEmail, role, organizationId: orgId });
	if (invited.status >= 400) {
		throw new Error(
			`invite-member failed (${invited.status}): ${invited.text}\n` +
				`  org ${orgSlug} (${orgId}) billing=${JSON.stringify(billing)}\n` +
				`  A 403 "upgrade_required" WITH a team/active billing row means the console resolved\n` +
				`  COMMUNITY entitlements, which happens when it did not load @alethia/ee: without the\n` +
				`  enterprise module lib/auth/scope.ts falls back to { orgId: userId }, an org with no\n` +
				`  billing record. Build it (\`pnpm -F @alethia/ee build\`) and restart the console —\n` +
				`  ee/dist is gitignored, so an rsync-based deploy can delete it out from under a\n` +
				`  running env. \`pnpm env:status\` reports the edition the PROCESS is serving.`,
		);
	}

	// 4. Accept, from the invitee's session.
	const invitationId = await pendingInvitationId(orgId, memberEmail);
	if (!invitationId) throw new Error(`no pending invitation for ${memberEmail} in ${orgId} after a ${invited.status}`);
	const accepted = await organizationApi(memberPage, "accept-invitation", { invitationId });
	if (accepted.status >= 400) {
		throw new Error(`accept-invitation failed (${accepted.status}): ${accepted.text}`);
	}
	// Best-effort, and deliberately NOT asserted: some builds answer 404 on `organization/set-active`,
	// and it does not matter — `[org]/layout.tsx` re-syncs the session's active org to the `{org}`
	// segment on every request, so the specs' `/{orgSlug}/…` navigations are scoped correctly anyway.
	await organizationApi(memberPage, "set-active", { organizationId: orgId });

	// 5. Read the membership back. The RETURNED role is the database's answer, not the argument —
	// an invite that silently landed a different role must not be reported as the one asked for.
	const rows = await db()<{ role: string; user_id: string }[]>`
		select m.role, m.user_id from member m
		join "user" u on u.id = m.user_id
		where m.organization_id = ${orgId} and u.email = ${memberEmail}`;
	const membership = rows[0];
	if (!membership) {
		throw new Error(
			`${memberEmail} has no member row in ${orgSlug} (${orgId}) after a ${accepted.status} ` +
				`accept-invitation — the persona would be denied everywhere for want of access, not of role.`,
		);
	}

	return {
		orgSlug,
		orgId,
		ownOrgSlug,
		role: membership.role,
		userId: membership.user_id,
		invitationId,
	};
}
