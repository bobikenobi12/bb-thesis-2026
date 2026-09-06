// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

import * as jose from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertionSourceForProvider,
  localAssertionSource,
  workloadAssertionSourceConfigured,
} from "@/lib/oidc/assertion-source";
import { __resetIssuerCache, getPublicJwks } from "@/lib/oidc/issuer";
import { testRsaKey } from "../../fixtures/rsa-keys";

afterEach(() => {
  for (const name of [
    "ALETHIA_OIDC_SIGNING_KEY",
    "NEXT_PUBLIC_APP_URL",
    "ALETHIA_E2E_ASSERTION_BROKER_URL",
    "ALETHIA_E2E_ASSERTION_BROKER_AUDIENCE",
    "ACTIONS_ID_TOKEN_REQUEST_URL",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "GITHUB_REPOSITORY",
    "GITHUB_WORKFLOW_REF",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_ATTEMPT",
  ]) {
    delete process.env[name];
  }
  vi.unstubAllGlobals();
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

describe("brokered workload assertion source", () => {
  it("obtains a GitHub assertion and returns a matching broker assertion", async () => {
    configureBroker();
    const now = Math.floor(Date.now() / 1000);
    const assertion = unsignedJwt({
      ...brokerJwtClaims(now),
      exp: now + 60,
    });
    const calls: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        calls.push(request);
        if (
          request.url.startsWith(
            "https://pipelines.actions.githubusercontent.com/",
          )
        ) {
          return Promise.resolve(
            Response.json({ value: "github.assertion.token" }),
          );
        }
        return Promise.resolve(
          Response.json({
            assertion,
            issuer: "https://issuer.example.test",
            audience: "sts.amazonaws.com",
            subject: "alethia-connector",
            expiresAt: new Date((now + 60) * 1000).toISOString(),
            run: brokerRun(),
          }),
        );
      }),
    );

    const result = await assertionSourceForProvider("aws").getAssertion({
      audience: "sts.amazonaws.com",
      ttlSeconds: 60,
    });
    expect(result).toBe(assertion);
    expect(calls[0]?.url).toContain("audience=alethia-e2e-broker");
    expect(calls[0]?.headers.get("authorization")).toBe(
      "Bearer github-runtime-token",
    );
    expect(calls[1]?.url).toBe("https://issuer.example.test/v1/assertions");
    expect(calls[1]?.headers.get("authorization")).toBe(
      "Bearer github.assertion.token",
    );
    expect(await calls[1]?.json()).toMatchObject({
      provider: "aws",
      audience: "sts.amazonaws.com",
      ttlSeconds: 60,
      run: brokerRun(),
    });
  });

  it("reports broker readiness only when the complete GitHub runtime is present", () => {
    configureBroker();
    expect(workloadAssertionSourceConfigured()).toBe(true);
    delete process.env.GITHUB_RUN_ID;
    expect(workloadAssertionSourceConfigured()).toBe(false);
  });

  it("surfaces a broker refusal without retaining its response or token", async () => {
    configureBroker();
    mockGithubThen(
      Response.json(
        { error: "denied", assertion: "must-not-leak" },
        { status: 403 },
      ),
    );
    await expect(
      assertionSourceForProvider("gcp").getAssertion({
        audience: "alethia-gcp-wif",
      }),
    ).rejects.toThrow("E2E assertion broker refused the request (HTTP 403).");
  });

  it("refuses malformed, expired, and provider-mismatched assertions", async () => {
    configureBroker();
    const now = Math.floor(Date.now() / 1000);
    for (const assertion of [
      "not.a.jwt",
      unsignedJwt({
        ...brokerJwtClaims(now),
        exp: now - 1,
      }),
      unsignedJwt({
        ...brokerJwtClaims(now),
        provider: "azure",
        exp: now + 60,
      }),
    ]) {
      mockGithubThen(
        Response.json({
          assertion,
          issuer: "https://issuer.example.test",
          audience: "sts.amazonaws.com",
          subject: "alethia-connector",
          expiresAt: new Date((now + 60) * 1000).toISOString(),
          run: brokerRun(),
        }),
      );
      await expect(
        assertionSourceForProvider("aws").getAssertion({
          audience: "sts.amazonaws.com",
        }),
      ).rejects.toThrow(/malformed|outside the requested scope/);
      vi.unstubAllGlobals();
    }
  });

  it("rejects a non-GitHub OIDC callback before making a network request", async () => {
    configureBroker();
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL = "https://attacker.example/token";
    const network = vi.fn();
    vi.stubGlobal("fetch", network);
    await expect(
      assertionSourceForProvider("alibaba").getAssertion({
        audience: "sts.aliyuncs.com",
      }),
    ).rejects.toThrow("is not a GitHub Actions HTTPS URL");
    expect(network).not.toHaveBeenCalled();
  });
});

/** Sets the complete non-secret test metadata and opaque GitHub runtime token. */
function configureBroker(): void {
  process.env.ALETHIA_E2E_ASSERTION_BROKER_URL = "https://issuer.example.test";
  process.env.ALETHIA_E2E_ASSERTION_BROKER_AUDIENCE = "alethia-e2e-broker";
  process.env.ACTIONS_ID_TOKEN_REQUEST_URL =
    "https://pipelines.actions.githubusercontent.com/example/token";
  process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = "github-runtime-token";
  process.env.GITHUB_REPOSITORY = "alethialabs-io/alethialabs";
  process.env.GITHUB_WORKFLOW_REF =
    "alethialabs-io/alethialabs/.github/workflows/e2e-nightly.yml@refs/heads/dev";
  process.env.GITHUB_RUN_ID = "123456";
  process.env.GITHUB_RUN_ATTEMPT = "2";
}

/** Returns the run identity sent to the broker. */
function brokerRun() {
  return {
    repository: "alethialabs-io/alethialabs",
    workflowRef:
      "alethialabs-io/alethialabs/.github/workflows/e2e-nightly.yml@refs/heads/dev",
    runId: "123456",
    runAttempt: 2,
  };
}

/** Returns the invariant claims expected from an AWS broker response. */
function brokerJwtClaims(iat: number): { [key: string]: unknown } {
  const run = brokerRun();
  return {
    iss: "https://issuer.example.test",
    sub: "alethia-connector",
    aud: "sts.amazonaws.com",
    provider: "aws",
    iat,
    repository: run.repository,
    workflow_ref: run.workflowRef,
    run_id: run.runId,
    run_attempt: run.runAttempt,
  };
}

/** Mocks a successful GitHub exchange followed by the supplied broker response. */
function mockGithubThen(brokerResponse: Response): void {
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      calls += 1;
      return Promise.resolve(
        calls === 1
          ? Response.json({ value: "github.assertion.token" })
          : brokerResponse,
      );
    }),
  );
}

/** Builds a compact test JWT whose payload can be decoded without verification. */
function unsignedJwt(payload: { [key: string]: unknown }): string {
  return `${encodePart({ alg: "RS256", kid: "test" })}.${encodePart(payload)}.signature`;
}

/** Encodes one JSON JWT segment using URL-safe Base64. */
function encodePart(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
