// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The decision logic of the CLI device-code flow (RFC 8628): the expiry deadline the
// exchange enforces, the ownership gate that stops one account's device code being
// re-pointed at another, the user_code/device_code shapes, and the rate-limit bucket key.

import { describe, expect, it } from "vitest";

import {
	CLI_DEVICE_RATE_LIMIT,
	DEVICE_CODE_TTL_MS,
	checkDeviceCodeBinding,
	deviceCodeDeadline,
	deviceCodeExpiresAt,
	isDeviceCodeExpired,
	isValidDeviceCode,
	isValidUserCode,
} from "@/lib/auth/cli-device-code";
import { cliDeviceRateLimitKey, trustedClientIp } from "@/lib/auth/trusted-ip";

/** A device_code in the shape `alethia login` mints (uuid.New()). */
const HYG_CLI_AUTHFLOW_DEVICE_CODE = "2f1c8c1e-7a4b-4d2e-9a3f-0b5c6d7e8f90";

/** Builds a Headers object from a plain record. */
function hygCliAuthflowHeaders(init: Record<string, string>): Headers {
	return new Headers(init);
}

describe("device-code expiry", () => {
	it("writes a deadline one TTL ahead", () => {
		const now = Date.UTC(2026, 7, 9, 12, 0, 0);
		expect(deviceCodeExpiresAt(now).getTime()).toBe(now + DEVICE_CODE_TTL_MS);
	});

	it("prefers the stored expires_at", () => {
		const expires = new Date(2_000_000);
		const created = new Date(0);
		expect(deviceCodeDeadline({ expires_at: expires, created_at: created })).toEqual(
			expires,
		);
	});

	it("falls back to created_at + TTL for a legacy row with a NULL expires_at", () => {
		// Every row written before this change has expires_at NULL, because the generate
		// route never wrote it. A lenient `expires_at && expires_at < now` would leave all
		// of them immortal — which is the bug.
		const created = new Date(1_000_000);
		expect(deviceCodeDeadline({ expires_at: null, created_at: created })).toEqual(
			new Date(1_000_000 + DEVICE_CODE_TTL_MS),
		);
		expect(
			isDeviceCodeExpired(
				{ expires_at: null, created_at: created },
				1_000_000 + DEVICE_CODE_TTL_MS + 1,
			),
		).toBe(true);
		expect(
			isDeviceCodeExpired({ expires_at: null, created_at: created }, 1_000_001),
		).toBe(false);
	});

	it("fails closed when neither column supplies a deadline", () => {
		expect(deviceCodeDeadline({ expires_at: null, created_at: null })).toBeNull();
		expect(isDeviceCodeExpired({ expires_at: null, created_at: null }, 0)).toBe(true);
	});

	it("treats now === deadline as expired", () => {
		// The >= vs > boundary: at the instant the deadline is reached the code is dead.
		const deadline = new Date(5_000_000);
		const row = { expires_at: deadline, created_at: null };
		expect(isDeviceCodeExpired(row, 4_999_999)).toBe(false);
		expect(isDeviceCodeExpired(row, 5_000_000)).toBe(true);
		expect(isDeviceCodeExpired(row, 5_000_001)).toBe(true);
	});
});

describe("device-code ownership binding", () => {
	it("allows a brand-new device code", () => {
		expect(checkDeviceCodeBinding(undefined, "user-1")).toEqual({ ok: true });
	});

	it("allows an unapproved row and a re-approval by the same account", () => {
		expect(checkDeviceCodeBinding({ profile_id: null }, "user-1")).toEqual({
			ok: true,
		});
		expect(checkDeviceCodeBinding({ profile_id: "user-1" }, "user-1")).toEqual({
			ok: true,
		});
	});

	it("refuses a device code already bound to another account", () => {
		// The takeover: a phished /cli/login link used to re-point the ATTACKER's device
		// code at the victim, because the upsert overwrote profile_id unconditionally.
		expect(checkDeviceCodeBinding({ profile_id: "attacker" }, "victim")).toEqual({
			ok: false,
			reason: "bound_to_another_account",
		});
	});
});

describe("code shapes", () => {
	it("accepts the user_code the CLI mints", () => {
		expect(isValidUserCode("BCDF-GHJK")).toBe(true);
		expect(isValidUserCode("ZXWV-TSRQ")).toBe(true);
	});

	it("rejects ambiguous characters, wrong shapes and non-strings", () => {
		for (const bad of [
			"BCD0-GHJK", // 0
			"BCDO-GHJK", // O
			"BCD1-GHJK", // 1
			"BCDI-GHJK", // I
			"BCDL-GHJK", // L
			"bcdf-ghjk", // lower case
			"BCDFGHJK", // no separator
			"BCDF-GHJ", // too short
			"BCDF-GHJKM", // too long
			"",
		]) {
			expect(`${bad}:${isValidUserCode(bad)}`).toBe(`${bad}:false`);
		}
		expect(isValidUserCode(undefined)).toBe(false);
		expect(isValidUserCode(42)).toBe(false);
	});

	it("requires a UUID-shaped device_code", () => {
		expect(isValidDeviceCode(HYG_CLI_AUTHFLOW_DEVICE_CODE)).toBe(true);
		expect(isValidDeviceCode("not-a-uuid")).toBe(false);
		expect(isValidDeviceCode("")).toBe(false);
		expect(isValidDeviceCode(null)).toBe(false);
	});
});

describe("rate-limit bucket key", () => {
	it("keys on the trusted cf-connecting-ip", () => {
		const headers = hygCliAuthflowHeaders({ "cf-connecting-ip": "203.0.113.9" });
		expect(trustedClientIp(headers)).toBe("203.0.113.9");
		expect(cliDeviceRateLimitKey("exchange", headers)).toBe(
			"cli-device:exchange:203.0.113.9",
		);
		expect(cliDeviceRateLimitKey("generate", headers)).toBe(
			"cli-device:generate:203.0.113.9",
		);
	});

	it("ignores a client-supplied x-forwarded-for", () => {
		// x-forwarded-for is attacker-controlled: keying on it lets a rotating header mint
		// a fresh bucket for every request.
		const headers = hygCliAuthflowHeaders({ "x-forwarded-for": "203.0.113.9" });
		expect(trustedClientIp(headers)).toBeNull();
		expect(cliDeviceRateLimitKey("exchange", headers)).toBeNull();
	});

	it("fails open when there is no trusted IP header", () => {
		expect(cliDeviceRateLimitKey("exchange", hygCliAuthflowHeaders({}))).toBeNull();
		expect(
			cliDeviceRateLimitKey("exchange", hygCliAuthflowHeaders({ "cf-connecting-ip": "  " })),
		).toBeNull();
	});

	it("budgets for the CLI's 2-second poll", () => {
		// One honest login is ~30 requests/minute; a limit anywhere near 10 would throttle
		// a single legitimate user.
		expect(CLI_DEVICE_RATE_LIMIT.windowMs).toBe(60_000);
		expect(CLI_DEVICE_RATE_LIMIT.limit).toBeGreaterThanOrEqual(120);
	});
});
