// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("BETTER_AUTH_SECRET", "test-secret");
  vi.stubEnv("BETTER_AUTH_URL", "https://app.test");
  vi.stubEnv("ALETHIA_TRUSTED_IP_HEADER", "");
});

describe("trusted IP header configuration", () => {
  it("defaults to the hosted Cloudflare header", async () => {
    const { getAuthConfig } = await import("@/lib/config/auth");
    expect(getAuthConfig().trustedIpHeader).toBe("cf-connecting-ip");
  });

  it("normalizes an operator-selected header", async () => {
    vi.stubEnv("ALETHIA_TRUSTED_IP_HEADER", "X-Real-IP");
    const { getAuthConfig } = await import("@/lib/config/auth");
    expect(getAuthConfig().trustedIpHeader).toBe("x-real-ip");
  });

  it("rejects a list or malformed header name", async () => {
    vi.stubEnv("ALETHIA_TRUSTED_IP_HEADER", "x-real-ip, x-forwarded-for");
    const { getAuthConfig } = await import("@/lib/config/auth");
    expect(() => getAuthConfig()).toThrow("ALETHIA_TRUSTED_IP_HEADER");
  });
});
