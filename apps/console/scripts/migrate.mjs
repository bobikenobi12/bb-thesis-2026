// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// DB migrate runner — replaces the drizzle-kit CLI (whose spinner swallows
// errors). Applies the generated schema migrations, then the idempotent
// programmables (functions/triggers/RLS) via .unsafe(), then sets the app role's
// login password. Prints full errors and exits non-zero on failure.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(here, "../lib/db/migrations");
const programmablesPath = join(here, "../lib/db/programmables.sql");
const connectorsSeedPath = join(here, "../lib/db/seed/connectors.generated.sql");

const url = process.env.ALETHIA_DATABASE_URL;
if (!url) {
	console.error("✗ ALETHIA_DATABASE_URL is not set (see .env.example).");
	process.exit(1);
}

/** Escapes a string for use as a single-quoted SQL literal. */
function sqlLiteral(value) {
	return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Postgres NOTICEs that are routine and would drown the ones that matter.
 *
 * `IF NOT EXISTS` / `IF EXISTS` DDL emits one per object, every run, forever. They were the reason
 * `onnotice` was stubbed out entirely — which also discarded every `RAISE NOTICE` a migration wrote
 * ON PURPOSE.
 */
const ROUTINE_NOTICE = /(already exists, skipping|does not exist, skipping)/i;

// FORWARD NOTICES. A migration that rewrites user data says so with `RAISE NOTICE`, and
// `onnotice: () => {}` sent that to the floor: 0150 renames project names a person chose, name by
// name, and the deploy that applied it would have left NO record anywhere of which ones. postgres-js
// surfaces NOTICEs nowhere else, so the stub was the difference between an audit trail and a
// sentence in a migration file claiming one.
const sql = postgres(url, {
	max: 1,
	onnotice: (notice) => {
		const message = typeof notice?.message === "string" ? notice.message : String(notice);
		if (ROUTINE_NOTICE.test(message)) return;
		console.log(`  notice: ${message}`);
	},
});

// Postgres "already exists" error classes: duplicate_object (enum/type),
// duplicate_table, duplicate_column. They mean the schema is already present but
// the drizzle migration journal is out of sync — typically after regenerating
// the baseline migration over a populated volume.
const ALREADY_EXISTS_CODES = new Set(["42710", "42P07", "42712"]);

/**
 * Best-effort: report a migration failure to PostHog Error Tracking. The migrate one-shot is NOT the
 * Next app — it never loads instrumentation.ts — so without this its failures are invisible on any
 * dashboard and you'd have to read the container logs on the box. No-ops without
 * NEXT_PUBLIC_POSTHOG_KEY and never throws (telemetry must not change the migrate exit path). Mirrors
 * the client shape in apps/console/lib/analytics/server.ts (real cloud host, flush-per-capture).
 */
async function reportMigrateFailure(error, phase) {
	const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
	if (!key) return;
	try {
		const { PostHog } = await import("posthog-node");
		const rawHost = process.env.NEXT_PUBLIC_POSTHOG_HOST;
		const host =
			rawHost && rawHost.startsWith("http")
				? rawHost.replace(/\/$/, "")
				: "https://eu.i.posthog.com";
		const ph = new PostHog(key, { host, flushAt: 1, flushInterval: 0 });
		ph.captureException(error, `migrate:${process.env.ALETHIA_DEPLOYMENT_MODE || "local"}`, {
			source: "console-migrate",
			phase,
		});
		await ph.flush();
		await ph.shutdown();
	} catch {
		/* telemetry must never break the migrate exit path */
	}
}

// Which step is running — attached to the PostHog report so a failure is triaged without the logs.
let phase = "startup";

try {
	phase = "schema-migrations";
	console.log("→ applying schema migrations…");
	try {
		await migrate(drizzle(sql), { migrationsFolder });
	} catch (migrateErr) {
		if (ALREADY_EXISTS_CODES.has(migrateErr?.cause?.code ?? migrateErr?.code)) {
			console.error(
				"\n✗ Schema objects already exist but the migration journal is out of sync\n" +
					"  (this happens when the baseline migration was regenerated over an existing volume).\n" +
					"  Run `pnpm db:reset` for a clean slate, or drop the conflicting objects.\n",
			);
			await reportMigrateFailure(migrateErr, "schema-migrations:journal-conflict");
			await sql.end({ timeout: 1 }).catch(() => {});
			process.exit(1);
		}
		throw migrateErr;
	}

	phase = "programmables";
	console.log("→ applying programmables (functions, triggers, RLS)…");
	await sql.unsafe(readFileSync(programmablesPath, "utf8"));

	phase = "connectors-seed";
	console.log("→ seeding connectors catalog (pluggable connectors)…");
	await sql.unsafe(readFileSync(connectorsSeedPath, "utf8"));

	const appPassword = process.env.ALETHIA_APP_DB_PASSWORD;
	if (appPassword) {
		phase = "app-role-password";
		console.log("→ setting app role login password…");
		await sql.unsafe(
			`ALTER ROLE alethia_app LOGIN PASSWORD ${sqlLiteral(appPassword)}`,
		);
	} else {
		console.warn(
			"⚠ ALETHIA_APP_DB_PASSWORD unset — alethia_app stays NOLOGIN (RLS-enforced app connection won't authenticate).",
		);
	}

	console.log("✓ database migrated");
	await sql.end();
	process.exit(0);
} catch (err) {
	console.error(`\n✗ migration failed (phase: ${phase}):\n`);
	console.error(err);
	await reportMigrateFailure(err, phase);
	await sql.end({ timeout: 1 }).catch(() => {});
	process.exit(1);
}
