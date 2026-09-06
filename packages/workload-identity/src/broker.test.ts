// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
  brokerAssertionRequestSchema,
  brokerAssertionResponseSchema,
} from "./broker";

const run = {
  repository: "alethialabs-io/alethialabs",
  workflowRef:
    "alethialabs-io/alethialabs/.github/workflows/e2e-nightly.yml@refs/heads/dev",
  runId: "123456",
  runAttempt: 2,
};

describe("broker assertion protocol", () => {
  it("defaults the fixed subject and bounded lifetime", () => {
    const parsed = brokerAssertionRequestSchema.parse({
      provider: "aws",
      audience: "sts.amazonaws.com",
      run,
    });
    expect(parsed.subject).toBe("alethia-connector");
    expect(parsed.ttlSeconds).toBe(600);
  });

  it("refuses unsupported providers, subjects, lifetimes, and extra fields", () => {
    for (const request of [
      { provider: "hetzner", audience: "aud", run },
      { provider: "aws", audience: "aud", subject: "admin", run },
      { provider: "aws", audience: "aud", ttlSeconds: 601, run },
      { provider: "aws", audience: "aud", run, credential: "secret" },
    ]) {
      expect(brokerAssertionRequestSchema.safeParse(request).success).toBe(
        false,
      );
    }
  });

  it("pins the response to HTTPS and echoes the run binding", () => {
    const response = {
      assertion: "header.payload.signature",
      issuer: "https://issuer.example.test",
      audience: "sts.amazonaws.com",
      subject: "alethia-connector",
      expiresAt: "2026-09-05T13:10:00Z",
      run,
    };
    expect(brokerAssertionResponseSchema.safeParse(response).success).toBe(
      true,
    );
    expect(
      brokerAssertionResponseSchema.safeParse({
        ...response,
        issuer: "http://localhost:3000",
      }).success,
    ).toBe(false);
  });
});
