// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Direct Postgres access for e2e setup/seeding. Connects with the owner role (ALETHIA_DATABASE_URL,
// role `alethia`) which is NOT the RLS-enforced app role — so INSERTs bypass RLS; seed rows must set
// both user_id AND org_id to the target persona so the app's app-role queries (RLS-scoped) see them.
// Used by global-setup (persona id lookup) and helpers/seed.ts (post-deploy state). Never imported by
// specs directly at runtime beyond seeding.

import postgres from "postgres";
import { loadRootEnv } from "./env";

let client: ReturnType<typeof postgres> | null = null;

/** A lazily-created, low-connection postgres client against the local dev DB. Reuse across a run. */
export function db(): ReturnType<typeof postgres> {
	if (client) return client;
	loadRootEnv();
	const url = process.env.ALETHIA_DATABASE_URL;
	if (!url) {
		throw new Error(
			"ALETHIA_DATABASE_URL is not set. The repo-root .env should define it; loadRootEnv() reads it. " +
				"Is the dev stack configured?",
		);
	}
	client = postgres(url, { max: 2, onnotice: () => {} });
	return client;
}

/** Closes the shared client (call in global-teardown if used). */
export async function closeDb(): Promise<void> {
	if (client) {
		await client.end({ timeout: 5 });
		client = null;
	}
}

/** Looks up a user's id by email (Better Auth `user` table). Returns null if absent. */
export async function userIdByEmail(email: string): Promise<string | null> {
	const rows = await db()<{ id: string }[]>`select id from "user" where email = ${email} limit 1`;
	return rows[0]?.id ?? null;
}

/** Looks up an organization's id by slug. Returns null if absent. */
export async function orgIdBySlug(slug: string): Promise<string | null> {
	const rows = await db()<{ id: string }[]>`select id from organization where slug = ${slug} limit 1`;
	return rows[0]?.id ?? null;
}

/**
 * The pending invitation id (used as the accept token) for an email into an org, newest first.
 *
 * `organization_id` / `created_at`, NOT the quoted camelCase they are declared with in
 * `lib/db/schema/organizations.ts`: the drizzle instance is built with `casing: "snake_case"`, so
 * the camelCase keys there are column NAMES only after that mapping. Quoting them here — outside
 * drizzle, on a raw `postgres` client — asked for columns that do not exist, and this helper threw
 * `42703` on every call it had ever been given (the audit's T7 spec inlined its own copy of the
 * query rather than use it, and flagged this).
 */
export async function pendingInvitationId(orgId: string, email: string): Promise<string | null> {
	const rows = await db()<{ id: string }[]>`
		select id from invitation
		where organization_id = ${orgId} and email = ${email} and status = 'pending'
		order by created_at desc limit 1`;
	return rows[0]?.id ?? null;
}
