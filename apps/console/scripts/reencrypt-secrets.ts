// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Online credential re-encryption pass. Rewrites every AES-GCM ciphertext at rest under the ACTIVE
// keyring kid (lib/crypto/secrets.ts) — the step that makes key rotation zero-downtime:
//
//   1. connector_credentials.credentials.secret  (jsonb ConnectorCredentials.secret)
//   2. cloud_identities.credentials.{token,s3_access_key,s3_secret_key}  (jsonb CloudCredentials)
//   3. alert_channels.secret                      (jsonb EncryptedSecret)
//   4. cloud inventory `sensitive` text columns   (JSON.stringify(EncryptedSecret), 15 tables)
//
// Idempotent (rows already at the active kid are skipped, so a second run changes 0), batched +
// resumable (keyset pagination by id; a re-run resumes because settled rows are skipped). It decrypts
// under ANY key in the ring and re-encrypts under the active key, so it works both for the initial
// stamp (legacy no-kid → active kid) and for a rotation (old kid → new kid). NEVER logs key material
// or plaintext — only row counts.
//
// Run: pnpm -C apps/console run db:reencrypt   (needs ALETHIA_DATABASE_URL + the keyring env vars set)
// See lib/crypto/secrets.ts for the full rotation runbook + ordering.

import { fileURLToPath } from "node:url";
import postgres from "postgres";
import {
	getActiveKid,
	isCredEncryptionConfigured,
	reencryptSecret,
} from "@/lib/crypto/secrets";
import type {
	CloudCredentials,
	ConnectorCredentials,
	EncryptedSecret,
} from "@/types/jsonb.types";

/** Tally of a re-encrypt pass over one logical location. */
export interface ReencryptCounts {
	/** Rows examined (that held some ciphertext). */
	scanned: number;
	/** Rows rewritten under the active kid. */
	changed: number;
	/** Rows already at the active kid (idempotent no-op). */
	skipped: number;
	/** Rows whose ciphertext could not be decrypted under any ring key (left untouched, logged). */
	failed: number;
}

/** A fresh zeroed tally. */
export function emptyCounts(): ReencryptCounts {
	return { scanned: 0, changed: 0, skipped: 0, failed: 0 };
}

/** Adds `b` into `a` in place and returns `a` (fold batch tallies into a running total). */
export function addCounts(a: ReencryptCounts, b: ReencryptCounts): ReencryptCounts {
	a.scanned += b.scanned;
	a.changed += b.changed;
	a.skipped += b.skipped;
	a.failed += b.failed;
	return a;
}

/**
 * Re-encrypts a single envelope value, tolerating null/undefined (returns unchanged). Throws if the
 * ciphertext can't be decrypted under any ring key — the caller decides how to record that.
 */
export function reencryptEnvelope(
	value: EncryptedSecret | null | undefined,
): { value: EncryptedSecret | null | undefined; changed: boolean } {
	if (value == null) return { value, changed: false };
	const { envelope, changed } = reencryptSecret(value);
	return { value: envelope, changed };
}

/**
 * Re-encrypts a sealed `sensitive` string (JSON.stringify(EncryptedSecret)) as used by the cloud
 * inventory rows. Returns the re-stringified value + whether it changed; passes null through. Throws
 * on an undecryptable/parse-invalid blob so the caller counts it as failed rather than corrupting it.
 */
export function reencryptSealedString(
	sealed: string | null | undefined,
): { value: string | null | undefined; changed: boolean } {
	if (sealed == null) return { value: sealed, changed: false };
	const envelope: EncryptedSecret = JSON.parse(sealed);
	const { envelope: next, changed } = reencryptSecret(envelope);
	return { value: changed ? JSON.stringify(next) : sealed, changed };
}

/**
 * Re-encrypts the secret inside a ConnectorCredentials blob (`.secret`). Returns a new blob only when
 * the secret changed; a credential with no secret is a no-op.
 */
export function reencryptConnectorCredentials(
	creds: ConnectorCredentials,
): { value: ConnectorCredentials; changed: boolean } {
	const { value, changed } = reencryptEnvelope(creds.secret);
	if (!changed) return { value: creds, changed: false };
	return { value: { ...creds, secret: value }, changed: true };
}

/**
 * Re-encrypts the three EncryptedSecret fields a CloudCredentials blob can carry (token +
 * Hetzner S3 access/secret keys). Returns a new blob only when at least one field changed.
 */
export function reencryptCloudCredentials(
	creds: CloudCredentials,
): { value: CloudCredentials; changed: boolean } {
	const token = reencryptEnvelope(creds.token);
	const s3Access = reencryptEnvelope(creds.s3_access_key);
	const s3Secret = reencryptEnvelope(creds.s3_secret_key);
	const changed = token.changed || s3Access.changed || s3Secret.changed;
	if (!changed) return { value: creds, changed: false };
	return {
		value: {
			...creds,
			token: token.value,
			s3_access_key: s3Access.value,
			s3_secret_key: s3Secret.value,
		},
		changed: true,
	};
}

// ── DB pass (only runs when executed as a script, not when imported by tests) ──────────────────────

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

/** The 15 cloud-inventory tables whose `sensitive` text column holds a sealed EncryptedSecret. */
const INVENTORY_TABLES = [
	"cloud_regions",
	"cloud_networks",
	"cloud_subnets",
	"cloud_nics",
	"cloud_dns_zones",
	"cloud_kubernetes_clusters",
	"cloud_databases",
	"cloud_caches",
	"cloud_queues",
	"cloud_topics",
	"cloud_nosql_tables",
	"cloud_container_registries",
	"cloud_secrets",
	"cloud_storage_buckets",
	"cloud_resources",
] as const;

/** Minimal typed handle for the postgres-js client (avoids `any` for the tagged-template client). */
type Sql = ReturnType<typeof postgres>;

/**
 * Wraps a typed record so postgres-js's `sql.json()` accepts it. Its JSONValue type admits any object
 * exposing `toJSON`, so this preserves the value verbatim without an `as` cast (and — unlike a
 * `${JSON.stringify(v)}::jsonb` fragment — postgres-js serializes it once, not double-encoded).
 */
function jsonParam(value: object): { toJSON: () => object } {
	return { toJSON: () => value };
}

/**
 * Re-encrypts the jsonb `credentials.secret` of every connector_credentials row, batched by id.
 * Rows already at the active kid are skipped; undecryptable rows are counted and left untouched.
 */
async function passConnectorCredentials(sql: Sql, batch: number): Promise<ReencryptCounts> {
	const counts = emptyCounts();
	let cursor = ZERO_UUID;
	for (;;) {
		const rows = await sql<{ id: string; credentials: ConnectorCredentials }[]>`
			select id, credentials from connector_credentials
			 where id > ${cursor} and credentials ? 'secret'
			 order by id limit ${batch}`;
		if (rows.length === 0) break;
		for (const row of rows) {
			counts.scanned++;
			try {
				const { value, changed } = reencryptConnectorCredentials(row.credentials);
				if (changed) {
					await sql`update connector_credentials set credentials = ${sql.json(jsonParam(value))}, updated_at = now() where id = ${row.id}`;
					counts.changed++;
				} else {
					counts.skipped++;
				}
			} catch {
				counts.failed++;
				console.warn(`  ! connector_credentials ${row.id}: could not decrypt (skipped)`);
			}
			cursor = row.id;
		}
		if (rows.length < batch) break;
	}
	return counts;
}

/**
 * Re-encrypts the jsonb `credentials` (token + S3 keys) of every cloud_identities row, batched by id.
 */
async function passCloudIdentities(sql: Sql, batch: number): Promise<ReencryptCounts> {
	const counts = emptyCounts();
	let cursor = ZERO_UUID;
	for (;;) {
		const rows = await sql<{ id: string; credentials: CloudCredentials }[]>`
			select id, credentials from cloud_identities
			 where id > ${cursor}
			   and (credentials ? 'token' or credentials ? 's3_access_key' or credentials ? 's3_secret_key')
			 order by id limit ${batch}`;
		if (rows.length === 0) break;
		for (const row of rows) {
			counts.scanned++;
			try {
				const { value, changed } = reencryptCloudCredentials(row.credentials);
				if (changed) {
					await sql`update cloud_identities set credentials = ${sql.json(jsonParam(value))}, updated_at = now() where id = ${row.id}`;
					counts.changed++;
				} else {
					counts.skipped++;
				}
			} catch {
				counts.failed++;
				console.warn(`  ! cloud_identities ${row.id}: could not decrypt (skipped)`);
			}
			cursor = row.id;
		}
		if (rows.length < batch) break;
	}
	return counts;
}

/**
 * Re-encrypts the jsonb `secret` of every alert_channels row that has one, batched by id.
 */
async function passAlertChannels(sql: Sql, batch: number): Promise<ReencryptCounts> {
	const counts = emptyCounts();
	let cursor = ZERO_UUID;
	for (;;) {
		const rows = await sql<{ id: string; secret: EncryptedSecret }[]>`
			select id, secret from alert_channels
			 where id > ${cursor} and secret is not null
			 order by id limit ${batch}`;
		if (rows.length === 0) break;
		for (const row of rows) {
			counts.scanned++;
			try {
				const { value, changed } = reencryptEnvelope(row.secret);
				if (changed && value != null) {
					await sql`update alert_channels set secret = ${sql.json(jsonParam(value))}, updated_at = now() where id = ${row.id}`;
					counts.changed++;
				} else {
					counts.skipped++;
				}
			} catch {
				counts.failed++;
				console.warn(`  ! alert_channels ${row.id}: could not decrypt (skipped)`);
			}
			cursor = row.id;
		}
		if (rows.length < batch) break;
	}
	return counts;
}

/**
 * Re-encrypts the `sensitive` text column of one cloud-inventory table, batched by id. The column is
 * a JSON.stringify(EncryptedSecret); parse/decrypt failures are counted and the row left untouched.
 */
async function passInventoryTable(
	sql: Sql,
	table: string,
	batch: number,
): Promise<ReencryptCounts> {
	const counts = emptyCounts();
	let cursor = ZERO_UUID;
	for (;;) {
		const rows = await sql<{ id: string; sensitive: string }[]>`
			select id, sensitive from ${sql(table)}
			 where id > ${cursor} and sensitive is not null
			 order by id limit ${batch}`;
		if (rows.length === 0) break;
		for (const row of rows) {
			counts.scanned++;
			try {
				const { value, changed } = reencryptSealedString(row.sensitive);
				if (changed) {
					await sql`update ${sql(table)} set sensitive = ${value ?? null} where id = ${row.id}`;
					counts.changed++;
				} else {
					counts.skipped++;
				}
			} catch {
				counts.failed++;
				console.warn(`  ! ${table} ${row.id}: could not decrypt sensitive (skipped)`);
			}
			cursor = row.id;
		}
		if (rows.length < batch) break;
	}
	return counts;
}

/** Formats a tally line for the run summary. */
function fmt(label: string, c: ReencryptCounts): string {
	return `  ${label.padEnd(28)} scanned=${c.scanned} changed=${c.changed} skipped=${c.skipped} failed=${c.failed}`;
}

/** Runs every re-encrypt pass against the DB and prints a summary. Exits non-zero on any failure. */
async function main(): Promise<void> {
	const url = process.env.ALETHIA_DATABASE_URL;
	if (!url) {
		console.error("✗ ALETHIA_DATABASE_URL is not set (see .env.example).");
		process.exit(1);
	}
	if (!isCredEncryptionConfigured()) {
		console.error(
			"✗ ALETHIA_CRED_ENCRYPTION_KEY is not set/valid — nothing to re-encrypt under.",
		);
		process.exit(1);
	}
	const batch = Number(process.env.REENCRYPT_BATCH || "500") || 500;
	const kid = getActiveKid();
	console.log(`→ re-encrypting all credential ciphertext under active kid "${kid}" (batch ${batch})…`);

	const sql = postgres(url, { max: 1, onnotice: () => {} });
	const total = emptyCounts();
	try {
		const conn = await passConnectorCredentials(sql, batch);
		console.log(fmt("connector_credentials", conn));
		addCounts(total, conn);

		const ident = await passCloudIdentities(sql, batch);
		console.log(fmt("cloud_identities", ident));
		addCounts(total, ident);

		const chan = await passAlertChannels(sql, batch);
		console.log(fmt("alert_channels", chan));
		addCounts(total, chan);

		for (const table of INVENTORY_TABLES) {
			const c = await passInventoryTable(sql, table, batch);
			// Only print inventory tables that held ciphertext, to keep the summary readable.
			if (c.scanned > 0) console.log(fmt(table, c));
			addCounts(total, c);
		}

		console.log(fmt("TOTAL", total));
		await sql.end();
		if (total.failed > 0) {
			console.error(`✗ ${total.failed} row(s) could not be re-encrypted (see warnings above).`);
			process.exit(1);
		}
		console.log("✓ re-encryption complete");
		process.exit(0);
	} catch (err) {
		console.error("\n✗ re-encryption failed:\n");
		console.error(err);
		await sql.end({ timeout: 1 }).catch(() => {});
		process.exit(1);
	}
}

// Only run the DB pass when invoked directly (`tsx scripts/reencrypt-secrets.ts`), not when a test
// imports the pure transforms above.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	void main();
}
