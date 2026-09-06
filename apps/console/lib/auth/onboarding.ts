// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Signup onboarding: give every new user a real, named organization (slug = their
// provider username) and make them its owner. Runs from the Better Auth
// user.create.after hook. The org plugin is EE-gated and not loaded at init, so we
// write organization/member directly; resolveOrgScope reads these tables anyway.

import { asc, eq } from "drizzle-orm";
import { ensureMemberGrant } from "@/lib/authz/grants";
import { getServiceDb } from "@/lib/db";
import { member, organization, user } from "@/lib/db/schema";
import { pickFreeSlug, RESERVED_SLUGS } from "@/lib/routing";
import { slugify } from "@/lib/utils/slugify";

interface NewUser {
	id: string;
	email: string;
	name?: string | null;
	username?: string | null;
}

/** The email local-part (`bob@x.com` → `bob`), or "" when unusable. */
function emailLocalPart(email: string): string {
	return email.split("@")[0] ?? "";
}

/**
 * Provisions a new user's primary organization: a real `organization` row named
 * after them (slug = their username, globally unique via pickFreeSlug), an owner
 * `member` row, and an owner grant mirrored into the PDP/OpenFGA. Idempotent — a
 * no-op once the user belongs to any org.
 */
export async function provisionPrimaryOrg(u: NewUser): Promise<void> {
	const db = getServiceDb();

	// Idempotency: skip if the user already has a membership.
	const existingMember = await db
		.select({ id: member.id })
		.from(member)
		.where(eq(member.userId, u.id))
		.limit(1);
	if (existingMember.length > 0) return;

	// Handle: prefer the provider username, then the display name, then the email
	// local-part. Drives both the org's display name and its slug.
	const handle = u.username || u.name || emailLocalPart(u.email) || "user";
	const orgName = `${handle}'s Org`;

	const taken = await db
		.select({ slug: organization.slug })
		.from(organization);
	const slug = pickFreeSlug(slugify(handle, "org"), [
		...taken.map((r) => r.slug),
		...RESERVED_SLUGS,
	]);

	const [org] = await db
		.insert(organization)
		.values({ name: orgName, slug })
		.returning({ id: organization.id });
	if (!org) return;

	await db.insert(member).values({
		organizationId: org.id,
		userId: u.id,
		role: "owner",
		status: "active",
	});

	// Owner grant for the new org (Postgres grant + OpenFGA tuple mirror).
	await ensureMemberGrant(org.id, u.id, "owner");
}

/** The user's primary organization (earliest membership) — the org the /onboarding
 *  flow configures in place. Provisioned at signup by provisionPrimaryOrg. */
export interface PrimaryOrg {
	id: string;
	name: string;
	slug: string;
	logo: string | null;
	role: string;
}

/** Resolves the user's primary org (earliest membership), or null if none. */
export async function getPrimaryOrg(userId: string): Promise<PrimaryOrg | null> {
	const [row] = await getServiceDb()
		.select({
			id: organization.id,
			name: organization.name,
			slug: organization.slug,
			logo: organization.logo,
			role: member.role,
		})
		.from(organization)
		.innerJoin(member, eq(member.organizationId, organization.id))
		.where(eq(member.userId, userId))
		.orderBy(asc(member.createdAt))
		.limit(1);
	if (!row) return null;
	// slug is non-null in practice (provisionPrimaryOrg always sets one); coerce
	// the nullable column type for the consumer.
	return { ...row, slug: row.slug ?? "" };
}

/**
 * The user's primary org, provisioning one first if it is missing.
 *
 * `provisionPrimaryOrg` runs from the `user.create.after` hook, where a failure is
 * logged and swallowed — it must not abort account creation. That left a real hole:
 * a user with no `member` row and a NULL `onboarding_completed_at` could not be served
 * by /dashboard (which routes them to /onboarding) *or* /onboarding (which had nothing
 * to configure), and the two bounced the user between them forever.
 *
 * So the read side repairs instead of redirecting. This is safe to call on every
 * /onboarding render: `provisionPrimaryOrg` is idempotent — it returns early once the
 * user holds any membership — so the happy path costs one indexed lookup and no write.
 *
 * Returns null only when provisioning genuinely cannot succeed (the DB or the PDP is
 * down), which the caller must render as a terminal error rather than a redirect.
 */
export async function ensurePrimaryOrg(
	userId: string,
): Promise<PrimaryOrg | null> {
	const existing = await getPrimaryOrg(userId);
	if (existing) return existing;

	const [row] = await getServiceDb()
		.select({ email: user.email, name: user.name, username: user.username })
		.from(user)
		.where(eq(user.id, userId))
		.limit(1);
	// No user row for a live session — nothing to provision against.
	if (!row) return null;

	try {
		await provisionPrimaryOrg({
			id: userId,
			email: row.email,
			name: row.name,
			username: row.username,
		});
	} catch (e) {
		console.error("[onboarding] org repair failed:", e);
		return null;
	}
	return getPrimaryOrg(userId);
}

/**
 * Whether the user has finished the post-signup /onboarding setup flow. Drives the
 * post-login gate: a NULL `onboarding_completed_at` (brand-new signup) routes the
 * user into /onboarding; pre-existing users are backfilled and skip it.
 */
export async function isOnboardingComplete(userId: string): Promise<boolean> {
	const [row] = await getServiceDb()
		.select({ at: user.onboardingCompletedAt })
		.from(user)
		.where(eq(user.id, userId))
		.limit(1);
	return Boolean(row?.at);
}

/** Marks the current user's onboarding as finished (idempotent). */
export async function completeOnboarding(userId: string): Promise<void> {
	await getServiceDb()
		.update(user)
		.set({ onboardingCompletedAt: new Date() })
		.where(eq(user.id, userId));
}
