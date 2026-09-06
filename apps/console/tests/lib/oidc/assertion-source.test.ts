// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

import * as jose from "jose";
import { afterEach, describe, expect, it } from "vitest";
import { localAssertionSource } from "@/lib/oidc/assertion-source";
import { __resetIssuerCache, getPublicJwks } from "@/lib/oidc/issuer";
import { testRsaKey } from "../../fixtures/rsa-keys";

afterEach(() => {
  delete process.env.ALETHIA_OIDC_SIGNING_KEY;
  delete process.env.NEXT_PUBLIC_APP_URL;
  __resetIssuerCache();
});

describe("local workload assertion source", () => {
  it("adapts the existing issuer without changing its token contract", async () => {
    process.env.ALETHIA_OIDC_SIGNING_KEY = testRsaKey(0).b64;
    process.env.NEXT_PUBLIC_APP_URL = "https://alethialabs.io";
    __resetIssuerCache();

    const assertion = await localAssertionSource.getAssertion({
      audience: "api://AzureADTokenExchange",
      ttlSeconds: 60,
    });
    const jwks = jose.createLocalJWKSet(await getPublicJwks());
    const { payload } = await jose.jwtVerify(assertion, jwks, {
      issuer: "https://alethialabs.io/api/oidc",
      audience: "api://AzureADTokenExchange",
    });
    expect(payload.sub).toBe("alethia-connector");
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(60);
  });
});
