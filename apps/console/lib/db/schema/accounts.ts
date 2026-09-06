// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { CliDeviceClientMetadata } from "@/types/jsonb.types";

// User profile (id matches the auth subject; no cross-DB FK — Better Auth owns
// users in Phase D). Kept so CLI auth + display can resolve email/name.
export const profiles = pgTable("profiles", {
	id: uuid().primaryKey(),
	email: text(),
	full_name: text(),
	avatar_url: text(),
	created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
});

// CLI device-code flow scratch records (service-role access only).
//
// A row now has THREE reachable lives, and which one it is in is read off the columns:
//
//   pending   profile_id NULL, denied_at NULL — `alethia login` registered the request at
//             /api/auth/cli/start and nobody has pressed anything yet. This row is what
//             /api/auth/cli/request renders the consent screen from, and it is why the
//             exchange's claiming DELETE is narrowed to `profile_id IS NOT NULL`: a poll
//             that deleted the pending row would take the consent screen's contents away
//             two seconds after the browser opened.
//   approved  profile_id set — /api/auth/cli/generate bound it to a signed-in account.
//   denied    denied_at set, profile_id NULL — the user pressed "This isn't me". The marker
//             has to be a durable ROW rather than the absence of one, because "no row" is
//             indistinguishable from "not approved yet", which is what let a refusal be
//             undone by reloading the link.
export const cliLogins = pgTable("cli_logins", {
	device_code: text().primaryKey(),
	verification_code: text(),
	profile_id: uuid().references(() => profiles.id),
	refresh_token: text(),
	expires_at: timestamp({ withTimezone: true }),
	created_at: timestamp({ withTimezone: true }).defaultNow(),
	// The RFC 8628 user_code the requesting client minted and printed to its terminal.
	// It used to exist only in the URL — `generate` checked its SHAPE and never compared
	// it — so the code on screen carried no server-verified meaning. Stored at
	// registration time, it becomes the value every later request must match.
	user_code: text(),
	// What the client SAID about itself. Untrusted by construction — see the interface.
	client_metadata: jsonb().$type<CliDeviceClientMetadata>(),
	// The client IP the trusted proxy header carried on the registration request.
	// Server-derived, unlike client_metadata, which is why it is its own column.
	request_ip: text(),
	// The deadline for the PENDING window — how long the user has to decide. Distinct from
	// `expires_at`, which is the post-approval redemption window: displaying that one as the
	// countdown would tell the user they have ten minutes starting from a moment that has
	// not happened yet.
	pending_expires_at: timestamp({ withTimezone: true }),
	// Set when the user refuses. Terminal: the exchange answers `access_denied` and no
	// later approval re-binds the row.
	denied_at: timestamp({ withTimezone: true }),
});

export type Profile = typeof profiles.$inferSelect;
export type CliLogin = typeof cliLogins.$inferSelect;
