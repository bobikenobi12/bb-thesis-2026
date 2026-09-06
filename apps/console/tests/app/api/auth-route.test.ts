// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(async () => new Response("get-handler")),
  post: vi.fn(async () => new Response("post-handler")),
  trustedIpFailure: vi.fn<(request: Request) => Response | null>(() => null),
}));

vi.mock("@/lib/auth", () => ({ auth: {} }));
vi.mock("@/lib/auth/trusted-ip", () => ({
  trustedIpFailure: mocks.trustedIpFailure,
}));
vi.mock("@/lib/authz/entitlements", () => ({
  getEntitlements: vi.fn(() => ({ organizations: true })),
}));
vi.mock("@/lib/authz/guard", () => ({
  currentActor: vi.fn(async () => ({ orgId: "org-1" })),
}));
vi.mock("better-auth/next-js", () => ({
  toNextJsHandler: vi.fn(() => ({ GET: mocks.get, POST: mocks.post })),
}));

import { GET, POST } from "@/app/api/auth/[...all]/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.trustedIpFailure.mockReturnValue(null);
});

describe("Better Auth trusted-IP boundary", () => {
  it("returns the ingress refusal before the GET handler", async () => {
    mocks.trustedIpFailure.mockReturnValueOnce(
      Response.json({ error: "trusted_ip_unavailable" }, { status: 503 }),
    );
    const response = await GET(
      new Request("https://app.test/api/auth/get-session"),
    );
    expect(response.status).toBe(503);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("returns the ingress refusal before the POST handler", async () => {
    mocks.trustedIpFailure.mockReturnValueOnce(
      Response.json({ error: "trusted_ip_unavailable" }, { status: 503 }),
    );
    const response = await POST(
      new Request("https://app.test/api/auth/sign-in/email-otp", {
        method: "POST",
      }),
    );
    expect(response.status).toBe(503);
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("delegates when the trusted-IP contract is satisfied", async () => {
    const request = new Request("https://app.test/api/auth/get-session");
    expect(await (await GET(request)).text()).toBe("get-handler");
    expect(mocks.get).toHaveBeenCalledWith(request);
  });
});
