// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// App-level encryption for api_key connector secrets (Cloudflare token, Vault
// token, Docker Hub PAT, …) stored in connector_credentials. Cloud identities and
// git tokens hold non-secret material (role ARNs, WIF config) and stay plaintext;
// these are real secrets, so we AEAD them at rest. Self-hosted has no guaranteed
// KMS, so this uses AES-256-GCM with a key supplied via ALETHIA_CRED_ENCRYPTION_KEY
// (32-byte base64). Decryption happens only in the claim endpoint, never client-side.
//
// ── Online key rotation (keyring + key-id) ──────────────────────────────────────
// A single key can't be rotated without downtime unless each ciphertext records WHICH
// key sealed it. Every envelope now carries an optional `kid` (key id); decryption
// selects the matching key from a KEYRING so multiple keys coexist:
//   • ACTIVE key   — ALETHIA_CRED_ENCRYPTION_KEY, its id ALETHIA_CRED_ENCRYPTION_KID
//                    (default "1"). All NEW writes use it and stamp its kid.
//   • RETIRED keys — ALETHIA_CRED_ENCRYPTION_KEY_<kid> (base64, 32 bytes each). Kept in
//                    the ring so ciphertext written under a prior active key still decrypts.
//   • LEGACY (no `kid`) ciphertext predates rotation — it was written under whatever key is
//                    currently ALETHIA_CRED_ENCRYPTION_KEY, so it decrypts under the ACTIVE key.
//
// Migration ordering (this is the ONLY safe sequence — legacy no-kid rows pin to the active key):
//   1. Deploy this code with the existing key as ALETHIA_CRED_ENCRYPTION_KEY and a chosen
//      ALETHIA_CRED_ENCRYPTION_KID (e.g. "1"). Nothing else changes; legacy rows still decrypt.
//   2. Run `pnpm -C apps/console run db:reencrypt` — stamps the active kid onto EVERY ciphertext
//      (connector secrets, cloud-identity tokens, alert-channel secrets, inventory `sensitive`).
//      After this, no no-kid rows remain, so the meaning of "active key" is no longer load-bearing
//      for legacy decryption.
//   3. To rotate: move the current key to ALETHIA_CRED_ENCRYPTION_KEY_<oldkid>, set a NEW
//      ALETHIA_CRED_ENCRYPTION_KEY + a NEW ALETHIA_CRED_ENCRYPTION_KID, deploy, then run
//      `db:reencrypt` again to re-seal every row under the new kid. Once every row bears the new
//      kid you may drop the retired key from the ring.
// A mid-rotation mix (some rows old-kid, some new-kid, some no-kid) all decrypts correctly as long
// as every referenced key is present in the ring — that's what makes the rotation ONLINE.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { EncryptedSecret } from "@/types/jsonb.types";

const ALGO = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const VERSION = 1;

// Default id for the active key when ALETHIA_CRED_ENCRYPTION_KID is unset. Kept simple so a
// first deploy needs only the key var (back-compat with single-key installs).
const DEFAULT_ACTIVE_KID = "1";
// Env prefix for retired keys: ALETHIA_CRED_ENCRYPTION_KEY_<kid>. Note this does NOT collide with
// ALETHIA_CRED_ENCRYPTION_KEY (no trailing underscore) or ALETHIA_CRED_ENCRYPTION_KID (…KID, not …KEY_).
const RETIRED_KEY_PREFIX = "ALETHIA_CRED_ENCRYPTION_KEY_";

/** The resolved set of keys available for encrypt/decrypt, plus which one is active. */
interface Keyring {
	/** Key id that new writes are sealed under. */
	activeKid: string;
	/** The 32-byte key for `activeKid` (also used to decrypt legacy no-kid ciphertext). */
	activeKey: Buffer;
	/** kid → 32-byte key, for every key in the ring (active + retired). */
	keys: Map<string, Buffer>;
}

let cachedKeyring: Keyring | null = null;

/**
 * Decodes a base64 env value into a 32-byte key buffer, throwing a clear, var-named error if it's
 * absent or the wrong length — fail closed rather than store secrets under a malformed key.
 */
function decodeKey(raw: string, varName: string): Buffer {
	const key = Buffer.from(raw, "base64");
	if (key.length !== KEY_BYTES) {
		throw new Error(
			`${varName} must decode to ${KEY_BYTES} bytes (got ${key.length}). ` +
				"Generate one with: openssl rand -base64 32",
		);
	}
	return key;
}

/**
 * Resolves the keyring from the environment, caching it. The ACTIVE key is
 * ALETHIA_CRED_ENCRYPTION_KEY (id ALETHIA_CRED_ENCRYPTION_KID, default "1"); RETIRED keys are every
 * ALETHIA_CRED_ENCRYPTION_KEY_<kid>. Throws a clear error if the active key is missing or malformed.
 */
function getKeyring(): Keyring {
	if (cachedKeyring) return cachedKeyring;

	const rawActive = process.env.ALETHIA_CRED_ENCRYPTION_KEY;
	if (!rawActive) {
		throw new Error(
			"ALETHIA_CRED_ENCRYPTION_KEY is not set — required to store connector credentials. " +
				"Generate one with: openssl rand -base64 32",
		);
	}
	const activeKey = decodeKey(rawActive, "ALETHIA_CRED_ENCRYPTION_KEY");
	// `|| DEFAULT` (not `??`) + trim so an empty-string emit (the prod deploy emits unset vars as "")
	// falls back to the default rather than yielding a "" kid.
	const activeKid =
		(process.env.ALETHIA_CRED_ENCRYPTION_KID || "").trim() || DEFAULT_ACTIVE_KID;

	const keys = new Map<string, Buffer>();
	keys.set(activeKid, activeKey);

	// Retired keys: every ALETHIA_CRED_ENCRYPTION_KEY_<kid>. The active kid always wins if a retired
	// var reuses it (defensive — a retired key should never share the active kid). A MALFORMED retired
	// key is skipped-with-warning rather than thrown: it must not poison the whole ring and take down
	// the valid ACTIVE encrypt/decrypt path (ciphertext under that kid will still fail with a clear
	// per-row error at decrypt time). The warning names only the env var, never key material.
	for (const [name, value] of Object.entries(process.env)) {
		if (!name.startsWith(RETIRED_KEY_PREFIX)) continue;
		const kid = name.slice(RETIRED_KEY_PREFIX.length);
		if (!kid || kid === activeKid) continue;
		if (!value || !value.trim()) continue;
		try {
			keys.set(kid, decodeKey(value, name));
		} catch {
			// eslint-disable-next-line no-console
			console.warn(
				`[secrets] ignoring malformed retired encryption key ${name} (must decode to ${KEY_BYTES} bytes); ` +
					`ciphertext under kid "${kid}" will not be decryptable until it is fixed.`,
			);
		}
	}

	cachedKeyring = { activeKid, activeKey, keys };
	return cachedKeyring;
}

/**
 * Clears the cached keyring so the next call re-reads the environment. For tests (which mutate the
 * key env vars between cases) and long-lived rotation tooling; the app never needs to call it.
 */
export function resetKeyringCache(): void {
	cachedKeyring = null;
}

/** Whether encryption is configured (a valid active key is present). */
export function isCredEncryptionConfigured(): boolean {
	try {
		getKeyring();
		return true;
	} catch {
		return false;
	}
}

/** The key id that new ciphertext is sealed under (the active key's id). */
export function getActiveKid(): string {
	return getKeyring().activeKid;
}

/**
 * Encrypts a map of secret fields into a versioned AES-256-GCM envelope, stamped with the ACTIVE
 * key id so it can be selected for decryption after a rotation.
 */
export function encryptSecret(fields: Record<string, string>): EncryptedSecret {
	const { activeKid, activeKey } = getKeyring();
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv(ALGO, activeKey, iv);
	const plaintext = Buffer.from(JSON.stringify(fields), "utf8");
	const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	const tag = cipher.getAuthTag();
	return {
		v: VERSION,
		kid: activeKid,
		iv: iv.toString("base64"),
		tag: tag.toString("base64"),
		data: data.toString("base64"),
	};
}

/**
 * Attempts to decrypt an envelope under one key. Returns the fields on success, or `null` if the
 * GCM auth tag doesn't verify (wrong key) or the plaintext isn't the expected JSON. GCM's
 * authentication guarantees a wrong key can NEVER yield a false-positive result — so this is the
 * safe primitive for "try each key in the ring" without risk of returning garbage.
 */
function tryDecryptWith(
	key: Buffer,
	envelope: EncryptedSecret,
): Record<string, string> | null {
	try {
		const decipher = createDecipheriv(ALGO, key, Buffer.from(envelope.iv, "base64"));
		decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
		const plaintext = Buffer.concat([
			decipher.update(Buffer.from(envelope.data, "base64")),
			decipher.final(),
		]);
		return JSON.parse(plaintext.toString("utf8"));
	} catch {
		return null;
	}
}

/**
 * Decrypts an envelope back into the map of secret fields. A `kid`-stamped envelope decrypts under
 * exactly that ring key (throws a clear error if the kid isn't in the ring, or if it fails to verify).
 * A LEGACY envelope with NO `kid` is tried against the active key first and then every other ring key
 * — it was written under whatever ALETHIA_CRED_ENCRYPTION_KEY was current at the time, which may since
 * have been moved into the ring as a retired key. GCM's auth tag makes trying-all-keys safe (only the
 * correct key authenticates), and it removes the "rotate before re-encrypting legacy rows" footgun: a
 * premature active-key rotation no longer strands no-kid rows as long as the old key stays in the ring.
 * Throws on tamper / when no key decrypts.
 */
export function decryptSecret(
	envelope: EncryptedSecret,
): Record<string, string> {
	const ring = getKeyring();
	if (envelope.kid != null) {
		const found = ring.keys.get(envelope.kid);
		if (!found) {
			throw new Error(
				`No decryption key for kid "${envelope.kid}" in the keyring — ` +
					"add it as ALETHIA_CRED_ENCRYPTION_KEY_" +
					`${envelope.kid} (base64, 32 bytes) or as the active ALETHIA_CRED_ENCRYPTION_KEY.`,
			);
		}
		const fields = tryDecryptWith(found, envelope);
		if (fields === null) {
			throw new Error(
				`Failed to decrypt secret under kid "${envelope.kid}" — the ciphertext is tampered or the ` +
					"configured key for that kid is wrong.",
			);
		}
		return fields;
	}
	// Legacy no-kid: try the active key first, then every other ring key.
	for (const key of [ring.activeKey, ...ring.keys.values()]) {
		const fields = tryDecryptWith(key, envelope);
		if (fields !== null) return fields;
	}
	throw new Error(
		"Could not decrypt a legacy (no-kid) secret with any key in the keyring — the key it was " +
			"written under is missing from the ring (add it, then re-run `db:reencrypt`).",
	);
}

/**
 * Re-seals an envelope under the ACTIVE key/kid. Idempotent: if it already bears the active kid it's
 * returned unchanged (`changed:false`, no crypto work) so a re-encrypt pass can skip settled rows;
 * otherwise it's decrypted under whichever ring key its kid selects and re-encrypted under the active
 * key. Throws (does not silently drop) if the source ciphertext can't be decrypted — the caller must
 * decide how to handle an un-decryptable row, never write garbage over it.
 */
export function reencryptSecret(envelope: EncryptedSecret): {
	envelope: EncryptedSecret;
	changed: boolean;
} {
	if (envelope.kid != null && envelope.kid === getKeyring().activeKid) {
		return { envelope, changed: false };
	}
	const fields = decryptSecret(envelope);
	return { envelope: encryptSecret(fields), changed: true };
}
