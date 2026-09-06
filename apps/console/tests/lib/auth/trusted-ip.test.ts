// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  header: "cf-connecting-ip",
  rateLimitEnabled: true,
}));

vi.mock("@/lib/config/auth", () => ({
  getAuthConfig: () => ({ trustedIpHeader: state.header }),
  getAuthRateLimit: () => ({ enabled: state.rateLimitEnabled }),
}));

import {
  cliDeviceRateLimitKey,
  trustedClientIp,
  trustedIpFailure,
} from "@/lib/auth/trusted-ip";

afterEach(() => {
  state.header = "cf-connecting-ip";
  state.rateLimitEnabled = true;
  vi.unstubAllEnvs();
});

describe("trusted client IP", () => {
  it("reads a valid address from the configured header", () => {
    state.header = "x-real-ip";
    const headers = new Headers({ "x-real-ip": "2001:db8::1" });
    expect(trustedClientIp(headers)).toBe("2001:db8::1");
    expect(cliDeviceRateLimitKey("exchange", headers)).toBe(
      "cli-device:exchange:2001:db8::1",
    );
  });

  it("rejects missing, malformed, and comma-separated values", () => {
    for (const value of [undefined, "not-an-ip", "198.51.100.1, 10.0.0.2"]) {
      const headers = new Headers(value ? { "cf-connecting-ip": value } : {});
      expect(trustedClientIp(headers)).toBeNull();
    }
  });
});

describe("production auth ingress", () => {
  it("fails closed without a valid trusted IP and does not cache the refusal", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const failure = trustedIpFailure(
      new Request("https://app.test/api/auth/get-session"),
    );
    expect(failure?.status).toBe(503);
    expect(failure?.headers.get("cache-control")).toBe("no-store");
    expect(await failure?.json()).toMatchObject({
      error: "trusted_ip_unavailable",
    });
  });

  it("allows a valid trusted IP", () => {
    vi.stubEnv("NODE_ENV", "production");
    const request = new Request("https://app.test/api/auth/get-session", {
      headers: { "cf-connecting-ip": "198.51.100.7" },
    });
    expect(trustedIpFailure(request)).toBeNull();
  });

  it("preserves development fallback and the explicit load-test opt-out", () => {
    expect(
      trustedIpFailure(new Request("https://app.test/api/auth/get-session")),
    ).toBeNull();
    vi.stubEnv("NODE_ENV", "production");
    state.rateLimitEnabled = false;
    expect(
      trustedIpFailure(new Request("https://app.test/api/auth/get-session")),
    ).toBeNull();
  });
});
