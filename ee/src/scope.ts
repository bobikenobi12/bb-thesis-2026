// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: LicenseRef-Alethia-Commercial

import { type SQL, sql } from "drizzle-orm";
import type { Actor } from "@/lib/authz/types";

/**
 * The one core capability the scope resolver needs: a tagged-SQL runner returning rows.
 * Declared structurally rather than as `CoreContext["db"]` so the resolver can be driven
 * against a stub — which is the point of lifting it out of `register()`, where reaching it
 * meant standing up the whole enterprise module first. Rows come back as `unknown` and are
 * narrowed below, so the stub needs no cast and no row type has to be asserted into place.
 */
export interface ScopeQueryRunner {
	execute(query: SQL): Promise<unknown[]>;
}

/**
 * The string `column` of the first row; null when there are no rows at all.
 *
 * A row that is present but carries no string `column` is neither — it is a query returning a
 * shape this module does not understand, and it THROWS. Answering "none" there would fold a
 * broken read into the same answer as an honest empty result, which is the shape of defect this
 * file is closing: a scope nobody asked for, arrived at silently.
 */
function firstString(rows: unknown[], column: string): string | null {
	const row: unknown = rows[0];
	if (row === undefined) return null;
	if (typeof row === "object" && row !== null && column in row) {
		const value: unknown = Reflect.get(row, column);
		if (typeof value === "string") return value;
	}
	throw new Error(`resolveActiveScope: row has no string "${column}"`);
}

/**
 * Maps a verified user to the org a request is scoped to.
 *
 * Three cases, in this order:
 *
 *  1. The named org IS the caller's personal org. A personal org's id is the user's own id
 *     and it has NO `member` row, so asking the membership table about it always misses.
 *     Resolve it as itself instead (#3863) — before that branch existed the miss fell
 *     through to case 3 and handed back a *different* org, so `X-Alethia-Org: <my user id>`
 *     was answered with a team org's rows, silently. That path is also walked by
 *     `POST /api/jobs`, which provisions and destroys real infrastructure.
 *  2. A named org the caller holds a `member` row in: that org.
 *  3. Nothing named (or a named org they are not a member of): the primary — earliest —
 *     membership, else the personal org.
 *
 * Case 3's fallback for a *named* org is deliberate and stays: this resolver also serves the
 * console session, where `activeOrganizationId` is a stored PREFERENCE that can name an org
 * the user has since left, and locking them out of the console over stale session state would
 * be the wrong trade. A request header is not a preference — it is an assertion about that one
 * request — so the caller that reads a header refuses the substitution rather than following
 * it. See `resolveNamedOrgScope` in apps/console/lib/authz/guard.ts.
 *
 * A FAILED lookup is never reported as a missing membership: `execute`'s rejection propagates
 * out of here untouched, so a database outage surfaces as an error rather than as a scope the
 * caller did not ask for.
 */
export async function resolveActiveScope(
	db: ScopeQueryRunner,
	userId: string,
	activeOrgId?: string,
): Promise<Actor> {
	// The personal org, named explicitly. No membership row exists for it, by construction.
	if (activeOrgId === userId) return { userId, orgId: userId };

	// Honor the selected org, but only if the user is a member of it.
	if (activeOrgId) {
		const selected = await db.execute(sql`
			select organization_id as id from member
			where user_id = ${userId}::uuid and organization_id = ${activeOrgId}::uuid
			limit 1
		`);
		if (firstString(selected, "id") !== null) return { userId, orgId: activeOrgId };
	}

	// Else the primary (earliest) membership; else the personal org.
	const rows = await db.execute(sql`
		select organization_id from member
		where user_id = ${userId}::uuid
		order by created_at asc
		limit 1
	`);
	return { userId, orgId: firstString(rows, "organization_id") ?? userId };
}
